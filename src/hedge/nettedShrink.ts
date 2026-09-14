/**
 * Netted shrink-and-remint dispatch builder.
 *
 * When the hedger SHRINKs a hedge it burns one or more borrowed-token loans and
 * remints a smaller one. The ordinary in-pool dispatch runs `swapAtMint` on both
 * the burn and the remint, so the pool swaps the GROSS notional of every loan
 * even though the two swaps largely cancel — the real hedge correction is only
 * the *principal reduction* (Σ burned principal − reminted principal).
 *
 * This module rebuilds that shrink as a "netted" dispatch that swaps only the
 * net:
 *
 *   1. mint a temporary loan sized to the principal reduction   (swapAtMint=false)
 *   2. mint the replacement loan                                (swapAtMint=false)
 *   3. burn the original loan(s)                                (swapAtMint=false)
 *   4. burn the temporary loan                                  (swapAtMint=true)
 *
 * Op 4 is the only swap: an exact-output repayment that sells just enough of the
 * counter-token to repay the temporary loan's principal. The temporary loan is
 * absent from `finalPositionIdList`, so a successful dispatch never leaves debt.
 *
 * The temporary mint/burn reuse one tokenId (mint then burn in a single
 * dispatch), which the ordinary batch validator rejects
 * (`duplicate-tokenid-in-batch`). We therefore assemble the wrapped sequence with
 * the SDK's {@link buildTemporaryLoanRecoveryDispatch} (which encodes the repeated
 * tokenId deliberately) and preview it with `simulateDispatch`, never
 * `simulateBatchDispatch`.
 *
 * SCOPE (v1): single-leg loans denominated in the borrowed token
 * (`asset === tokenType`), all on one side of one pool. Strike-converted or
 * mixed loan structures need separate protocol-rounding validation and are
 * rejected here. See the plan file for the follow-up.
 */
import {
  type BatchDispatchArgs,
  type Position,
  type TokenIdLeg,
  buildUniqueLoan,
  decodeTokenId,
  tickLimits,
} from '@panoptic-eng/sdk/v2'

import { MAX_TICK, MIN_TICK } from '../constants/ticks'

/** Minimal position shape the builder reads (a subset of the SDK `Position`). */
export type NettedShrinkPosition = Pick<Position, 'tokenId' | 'legs' | 'positionSize'>

/** The temporary loan minted and burned within the netted dispatch. */
export interface TemporaryLoan {
  /** Collision-free tokenId used exclusively for the temporary loan. */
  tokenId: bigint
  /**
   * Borrowed principal, in the borrowed token's smallest units. Equals the net
   * reduction by default; larger when the caller grew the loan past a share
   * boundary. Not the swap amount — the swap is always `amountOut`.
   */
  amount: bigint
}

/** A fully-assembled netted shrink candidate ready to simulate and (maybe) send. */
export interface NettedShrinkCandidate {
  /** The atomic `dispatch()` args: temp mint, replacement mint, burns, temp burn. */
  dispatch: BatchDispatchArgs
  /** Net principal reduction the single swap realizes (borrowed-token units). */
  amountOut: bigint
  /** The temporary loan wrapped around the restructuring. */
  temporaryLoan: TemporaryLoan
}

export interface BuildNettedShrinkParams {
  /** The ordinary in-pool shrink dispatch (as built for the original route). */
  dispatch: BatchDispatchArgs
  /**
   * The COMPLETE set of positions held before the dispatch (not just the burned
   * ones): `classifyOps` derives minted vs. untouched ids from this set, so an
   * incomplete set misclassifies untouched final positions as mints.
   */
  existingPositions: NettedShrinkPosition[]
  /**
   * The pool's CURRENT tick (e.g. `HedgeDeltaBreakdown.poolCurrentTick`), used to
   * center the temporary loan's swap band and choose its strike — NOT the
   * signal/mark tick used for delta marking. `decision.ts` keeps these separate.
   */
  currentTick: bigint
  /** Slippage tolerance (bps) for the exact-output repayment swap. */
  slippageBps: bigint
  /**
   * Optional override for the temporary loan principal. Defaults to the exact net
   * principal reduction. The route evaluator grows this when an exactly-sized
   * loan reverts by a share (see {@link nextTemporaryLoanAmount}).
   */
  loanAmount?: bigint
}

/** Why a shrink dispatch is not eligible for the netted route. */
export type NettedShrinkIneligibleReason =
  | 'not-a-shrink'
  | 'no-burns'
  | 'multi-leg-loan'
  | 'not-borrowed-token-denominated'
  | 'mixed-pool-or-side'
  | 'non-positive-reduction'

export type NettedShrinkEligibility =
  | { eligible: true }
  | { eligible: false; reason: NettedShrinkIneligibleReason; detail?: string }

const FULL_RANGE: readonly [bigint, bigint, bigint] = [BigInt(MIN_TICK), BigInt(MAX_TICK), 0n]

/** A single-leg width-0 loan denominated in its borrowed token (`asset==tokenType`). */
function loanLeg(legs: TokenIdLeg[]): TokenIdLeg | null {
  if (legs.length !== 1) return null
  const leg = legs[0]
  if (leg.width !== 0n || leg.isLong) return null
  if (leg.asset !== leg.tokenType) return null
  return leg
}

/**
 * Classify a dispatch's ops relative to the pre-dispatch positions.
 *
 * A burned id is present in the ops but absent from `finalPositionIdList`; a
 * minted id is present in `finalPositionIdList` but not held before. Op order is
 * preserved so `positionSizes`/`tickAndSpreadLimits` stay aligned by index.
 */
function classifyOps(dispatch: BatchDispatchArgs, existingIds: Set<bigint>) {
  const finalSet = new Set(dispatch.finalPositionIdList)
  const burnedIds: bigint[] = []
  const mintedIds: bigint[] = []
  for (const id of dispatch.positionIdList) {
    if (!finalSet.has(id)) burnedIds.push(id)
  }
  for (const id of dispatch.finalPositionIdList) {
    if (!existingIds.has(id)) mintedIds.push(id)
  }
  return { burnedIds, mintedIds: new Set(mintedIds) }
}

/**
 * Check whether a shrink dispatch can be rebuilt as a netted candidate, and
 * report the net principal reduction when it can.
 */
export function evaluateNettedShrinkEligibility(
  params: Pick<BuildNettedShrinkParams, 'dispatch' | 'existingPositions'>,
): NettedShrinkEligibility & { amountOut?: bigint } {
  const { dispatch, existingPositions } = params
  const positionsById = new Map(existingPositions.map((p) => [p.tokenId, p]))
  const existingIds = new Set(existingPositions.map((p) => p.tokenId))
  const { burnedIds, mintedIds } = classifyOps(dispatch, existingIds)

  if (burnedIds.length === 0) return { eligible: false, reason: 'no-burns' }

  let poolId: `0x${string}` | null = null
  let side: bigint | null = null
  let burnedPrincipal = 0n

  for (const id of burnedIds) {
    const pos = positionsById.get(id)
    if (!pos) return { eligible: false, reason: 'no-burns', detail: `missing position ${id}` }
    const leg = loanLeg(pos.legs)
    if (!leg) {
      const multi = pos.legs.length !== 1 || pos.legs[0]?.width !== 0n || pos.legs[0]?.isLong
      return {
        eligible: false,
        reason: multi ? 'multi-leg-loan' : 'not-borrowed-token-denominated',
        detail: `burned ${id}`,
      }
    }
    const decoded = decodeTokenId(id)
    if (poolId === null) {
      poolId = decoded.poolId
      side = leg.tokenType
    } else if (decoded.poolId !== poolId || leg.tokenType !== side) {
      return { eligible: false, reason: 'mixed-pool-or-side', detail: `burned ${id}` }
    }
    burnedPrincipal += pos.positionSize * leg.optionRatio
  }

  let mintedPrincipal = 0n
  for (let i = 0; i < dispatch.positionIdList.length; i += 1) {
    const id = dispatch.positionIdList[i]
    if (!mintedIds.has(id)) continue
    const decoded = decodeTokenId(id)
    const leg = loanLeg(decoded.legs)
    if (!leg) {
      const multi = decoded.legs.length !== 1
      return {
        eligible: false,
        reason: multi ? 'multi-leg-loan' : 'not-borrowed-token-denominated',
        detail: `minted ${id}`,
      }
    }
    if (decoded.poolId !== poolId || leg.tokenType !== side) {
      return { eligible: false, reason: 'mixed-pool-or-side', detail: `minted ${id}` }
    }
    mintedPrincipal += dispatch.positionSizes[i] * leg.optionRatio
  }

  const amountOut = burnedPrincipal - mintedPrincipal
  if (amountOut <= 0n) return { eligible: false, reason: 'non-positive-reduction' }
  return { eligible: true, amountOut }
}

/**
 * Grow a reverted temporary-loan principal for the next attempt.
 *
 * Collateral trackers compare shares while `NotEnoughTokens` reports assets, so
 * an exactly-sized loan can revert by one share. Mirrors the SDK
 * `quoteTemporaryLoanRecovery` growth: advance by the reported residual, but at
 * least ~5%, so bounded forward progress is always made.
 */
export function nextTemporaryLoanAmount(current: bigint, residual: bigint): bigint {
  const geometric = (current + 19n) / 20n
  return current + (residual > geometric ? residual : geometric)
}

/**
 * Build a netted shrink candidate from an ordinary in-pool shrink dispatch.
 *
 * Throws if the dispatch is ineligible (call {@link evaluateNettedShrinkEligibility}
 * first to branch without throwing).
 */
export function buildNettedShrinkDispatch(params: BuildNettedShrinkParams): NettedShrinkCandidate {
  const { dispatch, existingPositions, currentTick, slippageBps } = params
  const eligibility = evaluateNettedShrinkEligibility(params)
  if (!eligibility.eligible) {
    throw new Error(
      `dispatch not eligible for netted shrink: ${eligibility.reason}` +
        (eligibility.detail ? ` (${eligibility.detail})` : ''),
    )
  }
  const netReduction = eligibility.amountOut
  if (netReduction === undefined) {
    // Unreachable: an eligible result always carries amountOut. Guarded to avoid
    // a non-null assertion.
    throw new Error('netted shrink: eligible dispatch missing net reduction')
  }
  // The net swap the temporary burn performs is ALWAYS the principal reduction,
  // independent of how much the temporary loan borrows: any surplus borrowed by a
  // grown loan is repaid out of the mint proceeds within the same dispatch and
  // never reaches the swap. So `amountOut` (the swap) tracks the net reduction,
  // while `loanPrincipal` is what the temporary loan actually borrows (grown by
  // the caller on a share-boundary revert — see `nextTemporaryLoanAmount`).
  const amountOut = netReduction
  const loanPrincipal = params.loanAmount ?? netReduction

  const existingIds = new Set(existingPositions.map((p) => p.tokenId))
  const { mintedIds } = classifyOps(dispatch, existingIds)

  // Determine the borrowed-token side and pool metadata from a burned loan.
  const firstBurn = dispatch.positionIdList.find((id) => existingIds.has(id))
  if (firstBurn === undefined) {
    throw new Error('netted shrink: no burned loan found in dispatch')
  }
  const decodedBurn = decodeTokenId(firstBurn)
  const tokenIndex = decodedBurn.legs[0].tokenType as 0n | 1n
  const poolId = BigInt(decodedBurn.poolId)
  const tickSpacing = decodedBurn.tickSpacing

  // Reorder the original ops mint-first and strip every swap: the temporary loan
  // (op 4) performs the only swap. Mint-first makes the replacement's borrowed
  // tokens available before the burns repay the old loans (burn-first can revert
  // with NotEnoughTokens even when the final state is affordable).
  const ops = dispatch.positionIdList.map((id, i) => ({
    id,
    size: dispatch.positionSizes[i],
  }))
  const mints = ops.filter((op) => mintedIds.has(op.id))
  const burns = ops.filter((op) => !mintedIds.has(op.id))
  const ordered = [...mints, ...burns]

  const collisionIds = Array.from(
    new Set([...existingIds, ...dispatch.positionIdList, ...dispatch.finalPositionIdList]),
  )
  const loan = buildUniqueLoan(
    poolId,
    tokenIndex,
    tokenIndex,
    currentTick,
    tickSpacing,
    collisionIds,
    loanPrincipal,
  )

  // Assemble the wrapped sequence directly rather than via
  // `buildTemporaryLoanRecoveryDispatch`: that helper applies ONE tick-limit pair
  // to both the temporary mint and burn. We need the burn to carry a narrow
  // descending swap band (op 4, the only swap) while the temporary mint — a
  // width-0, no-swap op — keeps the full-range ascending band, matching the
  // repo's `hedgeTickBand(false, …)` convention. A narrow band on a no-swap mint
  // can PriceBoundFail when the pool tick drifts past `slippageBps` between
  // planning and inclusion. The repeated temporary tokenId (mint then burn) is
  // intentional and is why this dispatch must be previewed with `simulateDispatch`.
  const swapBand = tickLimits(currentTick, slippageBps)
  const wrapped: BatchDispatchArgs = {
    positionIdList: [loan.tokenId, ...ordered.map((op) => op.id), loan.tokenId],
    finalPositionIdList: [...dispatch.finalPositionIdList],
    positionSizes: [loan.adjustedSize, ...ordered.map((op) => op.size), 0n],
    tickAndSpreadLimits: [
      [...FULL_RANGE] as [bigint, bigint, bigint], // temp mint: no swap
      ...ordered.map(() => [...FULL_RANGE] as [bigint, bigint, bigint]), // inner ops: no swap
      [swapBand.high, swapBand.low, 0n], // temp burn: descending = the only swap
    ],
    usePremiaAsCollateral: dispatch.usePremiaAsCollateral,
    builderCode: dispatch.builderCode,
  }

  return {
    dispatch: wrapped,
    amountOut,
    temporaryLoan: {
      tokenId: loan.tokenId,
      amount: loanPrincipal,
    },
  }
}
