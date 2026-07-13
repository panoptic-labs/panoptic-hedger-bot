import {
  getAccountCollateral,
  getCollateralAddresses,
  getPool,
  tickToSqrtPriceX96,
} from '@panoptic-eng/sdk/v2'
import type { Address, PublicClient } from 'viem'

import type { HedgeAction, HedgeIntent } from '../executor/types'
import { asSdkClient } from '../utils/sdkClient'
import {
  type PositionSnapshot,
  buildUniqueLoan,
  computePortfolioDelta,
  computePortfolioSizeInVaultAsset,
  toVaultFrameAtSqrtPriceX96,
  toVaultFrameAtTick,
} from './frame'

/** A hedge loan position reduced to the fields the planner needs. `size` is a positive magnitude in vault-asset units. */
export interface HedgeItem {
  tokenId: bigint
  /** Loan tokenType: === assetIndex means a short hedge (borrows asset); else long. */
  tokenType: bigint
  size: bigint
}

export interface PlanHedgeConfig {
  assetIndex: 0n | 1n
  deltaThresholdBps: bigint
  absoluteMaxHedgeCount: number
}

export interface PlannedMint {
  tokenType: bigint
  size: bigint
}

export interface PlanHedgeResult {
  action: HedgeAction
  mints: PlannedMint[]
  burns: bigint[]
  swapAtMint: boolean
  H: bigint
  Hstar: bigint
  driftBps: bigint
  triggers: { drift: boolean; overCap: boolean; signFlip: boolean }
}

const abs = (x: bigint): bigint => (x < 0n ? -x : x)
const sameSign = (a: bigint, b: bigint): boolean => (a > 0n && b > 0n) || (a < 0n && b < 0n)

/** tokenType for a hedge of the given direction. Positive delta ⇒ long ⇒ borrow numeraire. */
function tokenTypeForDirection(positiveDelta: boolean, assetIndex: 0n | 1n): bigint {
  const numeraire = assetIndex === 0n ? 1n : 0n
  return positiveDelta ? numeraire : assetIndex
}

/**
 * Pure hedge planner implementing the 5-case tree (OPEN / CLOSE_ALL / GROW /
 * SHRINK / FLIP) plus the state-preserving capacity overlay, per
 * apps/vault-managers/.../EFFICIENT_HEDGING_ALGORITHM.md.
 *
 * `netDelta` is the true total (options + hedges + collateral). H is the hedge
 * book's current signed contribution; H* = H − netDelta is its target.
 */
export function planHedge(
  netDelta: bigint,
  H_short: bigint,
  H_long: bigint,
  hedges: HedgeItem[],
  portfolioSize: bigint,
  cfg: PlanHedgeConfig,
): PlanHedgeResult {
  const H = H_long - H_short
  const Hstar = H - netDelta
  // Drift is measured against the option book normally; when all options are
  // closed but a hedge loan remains, fall back to the gross hedge book so a
  // standalone hedge still gets unwound toward H* (delta-neutral) instead of
  // being stranded with no trigger able to fire.
  const hedgeGross = H_short + H_long
  const sizeBasis = portfolioSize > 0n ? portfolioSize : hedgeGross
  const driftBps = sizeBasis > 0n ? (abs(netDelta) * 10_000n) / sizeBasis : 0n

  const drift = driftBps > cfg.deltaThresholdBps
  const overCap = hedges.length > cfg.absoluteMaxHedgeCount
  const signFlip = H !== 0n && Hstar !== 0n && !sameSign(H, Hstar)
  const triggers = { drift, overCap, signFlip }

  const none = (action: HedgeAction = 'none'): PlanHedgeResult => ({
    action,
    mints: [],
    burns: [],
    swapAtMint: true,
    H,
    Hstar,
    driftBps,
    triggers,
  })

  if (sizeBasis === 0n) return none()
  if (!(drift || overCap || signFlip)) return none()

  const consolidate = (): PlanHedgeResult => {
    // Capacity overlay: collapse all same-side hedges into one WITHOUT changing
    // wallet/net delta (swapAtMint=false, size = |H|).
    const positive = H > 0n
    return {
      action: 'consolidate',
      mints:
        abs(H) > 0n
          ? [{ tokenType: tokenTypeForDirection(positive, cfg.assetIndex), size: abs(H) }]
          : [],
      burns: hedges.map((h) => h.tokenId),
      swapAtMint: false,
      H,
      Hstar,
      driftBps,
      triggers,
    }
  }

  const growConsolidate = (): PlanHedgeResult => {
    // GROW that would breach the cap: close all + open one hedge sized to the
    // full target |H*| on the target side. This IS state-changing (delta moves
    // from H to H*), so swapAtMint=true.
    return {
      action: 'consolidate',
      mints:
        abs(Hstar) > 0n
          ? [{ tokenType: tokenTypeForDirection(Hstar > 0n, cfg.assetIndex), size: abs(Hstar) }]
          : [],
      burns: hedges.map((h) => h.tokenId),
      swapAtMint: true,
      H,
      Hstar,
      driftBps,
      triggers,
    }
  }

  // Off-side hedges (possible after restart adoption of manually-minted loans)
  // break two same-side assumptions. SHRINK handles it by burning net-side
  // hedges only (burning an off-side hedge moves H AWAY from the target); the
  // off-side position stays and keeps being netted into H — no burn-everything
  // slippage. The state-preserving capacity consolidate however sizes/one-sides
  // its remint assuming a single-sided book, so a mixed over-cap book is
  // rebuilt to |H*| instead (state-changing, swapAtMint=true: a one-time
  // slippage cost that also clears the self-offsetting pair).
  const netSide = tokenTypeForDirection(H > 0n, cfg.assetIndex)
  const mixedBook = H !== 0n && hedges.some((h) => h.tokenType !== netSide)
  if (mixedBook && overCap && !(drift || signFlip)) return growConsolidate()

  // Capacity overlay short-circuits the state-preserving-only case.
  if (overCap && !(drift || signFlip)) return consolidate()

  // Classify.
  if (H === 0n && Hstar === 0n) return none()

  const openMint = (): PlannedMint => ({
    tokenType: tokenTypeForDirection(Hstar > 0n, cfg.assetIndex),
    size: abs(Hstar),
  })

  let result: PlanHedgeResult
  if (H === 0n) {
    // Case A — OPEN
    result = { ...none('open'), mints: [openMint()] }
  } else if (Hstar === 0n) {
    // Case B — CLOSE_ALL
    result = { ...none('close_all'), burns: hedges.map((h) => h.tokenId) }
  } else if (!sameSign(H, Hstar)) {
    // Case E — FLIP
    result = { ...none('flip'), mints: [openMint()], burns: hedges.map((h) => h.tokenId) }
  } else if (abs(Hstar) > abs(H)) {
    // Case C — GROW (same side, incremental)
    const sameSide = tokenTypeForDirection(Hstar > 0n, cfg.assetIndex)
    // GROW promotion when the extra leg would breach the cap: consolidate to |H*|.
    if (hedges.length + 1 > cfg.absoluteMaxHedgeCount) return growConsolidate()
    result = { ...none('grow'), mints: [{ tokenType: sameSide, size: abs(Hstar) - abs(H) }] }
  } else if (abs(Hstar) < abs(H)) {
    // Case D — SHRINK (reduce existing hedges, never offset). Only net-side
    // hedges are burn candidates: on a mixed book, burning an off-side hedge
    // would move H away from the target. Net-side size always covers
    // removeAmount (< |H| <= net-side total).
    const sameSide = tokenTypeForDirection(H > 0n, cfg.assetIndex)
    const removeAmount = abs(H) - abs(Hstar)
    const candidates = hedges.filter((h) => h.tokenType === sameSide)
    const sorted = [...candidates].sort((a, b) => (a.size < b.size ? -1 : a.size > b.size ? 1 : 0))
    const burns: bigint[] = []
    let remintSize: bigint | null = null
    let runningRemoved = 0n
    for (const h of sorted) {
      if (runningRemoved + h.size <= removeAmount) {
        burns.push(h.tokenId)
        runningRemoved += h.size
        if (runningRemoved === removeAmount) break
      } else {
        burns.push(h.tokenId)
        remintSize = h.size - (removeAmount - runningRemoved)
        break
      }
    }
    result = {
      ...none('shrink'),
      burns,
      mints:
        remintSize !== null && remintSize > 0n ? [{ tokenType: sameSide, size: remintSize }] : [],
    }
  } else {
    // Same side, equal magnitude — nothing to do (unless capacity fired above).
    return overCap ? consolidate() : none()
  }

  return result
}

// ---------------------------------------------------------------------------
// Orchestrator: reads chain state, computes P/C/H, calls planHedge, resolves
// planned mints into collision-free loan tokenIds, and returns a HedgeIntent.
// ---------------------------------------------------------------------------

export interface ComputeHedgePlanDeps {
  publicClient: PublicClient
  poolAddress: Address
  chainId: bigint
  safeAddress: Address
  /** Tick at which to mark deltas (from the price signal source). */
  signalTick: bigint
  assetIndex: 0n | 1n
  deltaThresholdBps: bigint
  absoluteMaxHedgeCount: number
  slippageBps: bigint
  /** Open positions held by the Safe (from positionReader). */
  positions: PositionSnapshot[]
  /** Subset of `positions` that are the bot's hedge loans. */
  hedgePositions: PositionSnapshot[]
}

export interface HedgePlan extends PlanHedgeResult {
  intent: HedgeIntent
  netDelta: bigint
  portfolioSize: bigint
}

/**
 * Compute a full, execution-ready hedge plan for the current cycle.
 * The caller supplies the already-read positions (so position discovery and
 * hedge classification live in positionReader).
 */
export async function computeHedgePlan(deps: ComputeHedgePlanDeps): Promise<HedgePlan> {
  const { publicClient, poolAddress, chainId, safeAddress, signalTick, assetIndex } = deps

  const pool = await getPool({
    client: asSdkClient<typeof getPool>(publicClient),
    poolAddress,
    chainId,
  })
  const tickSpacing = BigInt(pool.poolKey.tickSpacing)
  const poolId = pool.poolId
  const openIds = deps.positions.map((p) => p.tokenId)

  const collateral = await getAccountCollateral({
    client: asSdkClient<typeof getAccountCollateral>(publicClient),
    poolAddress,
    account: safeAddress,
    collateralAddresses: getCollateralAddresses(pool),
  })
  const collateralAssetSide =
    assetIndex === 0n ? collateral.token0.assets : collateral.token1.assets
  const collateralDelta = toVaultFrameAtTick(
    collateralAssetSide,
    assetIndex,
    assetIndex,
    signalTick,
  )

  const positionsDelta = computePortfolioDelta(deps.positions, signalTick, tickSpacing, assetIndex)
  const netDelta = positionsDelta + collateralDelta
  const portfolioSize = computePortfolioSizeInVaultAsset(deps.positions, assetIndex)

  // Decompose the hedge book into short/long magnitudes (vault-asset frame).
  let H_short = 0n
  let H_long = 0n
  const hedgeItems: HedgeItem[] = []
  for (const h of deps.hedgePositions) {
    let sizeMag = 0n
    let side: bigint | null = null
    for (const leg of h.legs) {
      if (leg.width !== 0n) continue
      // The shrink/consolidate classifier assigns ONE tokenType per HedgeItem, so
      // a mixed-side (multi-leg) zero-width loan would be silently miscategorized
      // (last leg wins). The bot only mints single-leg loans; assert that here so
      // an unexpected multi-leg loan fails loudly instead of corrupting the book.
      if (side !== null && side !== leg.tokenType) {
        throw new Error(
          `hedge loan ${h.tokenId} has mixed-side zero-width legs; expected a single-side loan`,
        )
      }
      const notional = h.positionSize * leg.optionRatio
      const sizeVault = toVaultFrameAtSqrtPriceX96(
        notional,
        leg.asset,
        assetIndex,
        tickToSqrtPriceX96(leg.strike),
      )
      const mag = sizeVault < 0n ? -sizeVault : sizeVault
      sizeMag += mag
      side = leg.tokenType
      if (leg.tokenType === assetIndex) H_short += mag
      else H_long += mag
    }
    hedgeItems.push({ tokenId: h.tokenId, tokenType: side ?? assetIndex, size: sizeMag })
  }

  const plan = planHedge(netDelta, H_short, H_long, hedgeItems, portfolioSize, {
    assetIndex,
    deltaThresholdBps: deps.deltaThresholdBps,
    absoluteMaxHedgeCount: deps.absoluteMaxHedgeCount,
  })

  // Resolve at most one planned mint into a collision-free loan tokenId.
  // Floor-divide (bigint `/` truncates toward zero, which rounds negative,
  // non-aligned ticks the wrong way — into the higher spacing bucket).
  const spacingQuotient =
    signalTick / tickSpacing - (signalTick % tickSpacing !== 0n && signalTick < 0n ? 1n : 0n)
  const roundedStrike = spacingQuotient * tickSpacing
  let openTokenId: bigint | null = null
  let openPositionSize: bigint | null = null
  if (plan.mints.length > 0) {
    const mint = plan.mints[0]
    const { tokenId, adjustedSize } = buildUniqueLoan(
      poolId,
      { asset: assetIndex, tokenType: mint.tokenType, strike: roundedStrike },
      openIds,
      mint.size,
    )
    openTokenId = tokenId
    openPositionSize = adjustedSize
  }

  const intent: HedgeIntent = {
    action: plan.action,
    openTokenId,
    openPositionSize,
    swapAtMint: plan.swapAtMint,
    closeTokenIds: plan.burns,
    existingPositionIds: openIds,
    currentTick: signalTick,
    slippageBps: deps.slippageBps,
  }

  return { ...plan, intent, netDelta, portfolioSize }
}
