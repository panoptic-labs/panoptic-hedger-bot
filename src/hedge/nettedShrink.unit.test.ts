import { type BatchDispatchArgs, createTokenIdBuilder, decodeTokenId } from '@panoptic-eng/sdk/v2'
import { describe, expect, it } from 'vitest'

import { MAX_TICK, MIN_TICK } from '../constants/ticks'
import {
  type NettedShrinkPosition,
  buildNettedShrinkDispatch,
  evaluateNettedShrinkEligibility,
  nextTemporaryLoanAmount,
} from './nettedShrink'

// tickSpacing (60) is encoded at bit 48 of the 64-bit poolId; a zero there makes
// buildUniqueLoan divide by zero.
const POOL_ID = (60n << 48n) | 0x1234abcdn
const TICK = 198_193n

/** A single-leg borrowed-token loan (asset === tokenType). */
function loanId(tokenType: bigint, strike: bigint, optionRatio = 1n): bigint {
  return createTokenIdBuilder(POOL_ID)
    .addLoan({ asset: tokenType, tokenType, strike, optionRatio })
    .build()
}

function position(tokenId: bigint, positionSize: bigint): NettedShrinkPosition {
  return { tokenId, legs: decodeTokenId(tokenId).legs, positionSize }
}

/** A shrink dispatch: burn `burns`, mint one replacement. */
function shrinkDispatch(
  burns: { id: bigint; principal: bigint }[],
  replacement: { id: bigint; size: bigint } | null,
): { dispatch: BatchDispatchArgs; existingPositions: NettedShrinkPosition[] } {
  const swapBand: [bigint, bigint, bigint] = [TICK + 100n, TICK - 100n, 0n] // descending = swap
  const positionIdList = [...burns.map((b) => b.id), ...(replacement ? [replacement.id] : [])]
  const positionSizes = [...burns.map(() => 0n), ...(replacement ? [replacement.size] : [])]
  const finalPositionIdList = replacement ? [replacement.id] : []
  return {
    dispatch: {
      positionIdList,
      finalPositionIdList,
      positionSizes,
      tickAndSpreadLimits: positionIdList.map(() => swapBand),
      usePremiaAsCollateral: false,
      builderCode: 0n,
    },
    existingPositions: burns.map((b) => position(b.id, b.principal)),
  }
}

describe('evaluateNettedShrinkEligibility', () => {
  it('accepts a single-leg borrowed-token shrink and reports the net reduction', () => {
    const { dispatch, existingPositions } = shrinkDispatch(
      [{ id: loanId(0n, 0n), principal: 14_673_626745n }],
      { id: loanId(0n, 60n), size: 13_415_188888n },
    )
    const result = evaluateNettedShrinkEligibility({ dispatch, existingPositions })
    expect(result.eligible).toBe(true)
    expect(result.amountOut).toBe(1_258_437857n)
  })

  it('accepts a pure shrink with no remint (reduction = full burned principal)', () => {
    const { dispatch, existingPositions } = shrinkDispatch(
      [{ id: loanId(1n, 0n), principal: 5_000000n }],
      null,
    )
    const result = evaluateNettedShrinkEligibility({ dispatch, existingPositions })
    expect(result.eligible).toBe(true)
    expect(result.amountOut).toBe(5_000000n)
  })

  it('sums principals across multiple burned loans, honoring optionRatio', () => {
    const a = loanId(0n, 0n, 1n)
    const b = loanId(0n, 60n, 3n) // principal = positionSize * 3
    const { dispatch, existingPositions } = shrinkDispatch(
      [
        { id: a, principal: 10_000000n },
        { id: b, principal: 6_000000n }, // positionSize 6e6 * ratio 3 = 18e6 principal
      ],
      { id: loanId(0n, 120n), size: 4_000000n },
    )
    const result = evaluateNettedShrinkEligibility({ dispatch, existingPositions })
    // 10e6 + 18e6 - 4e6 = 24e6
    expect(result.amountOut).toBe(24_000000n)
  })

  it('rejects a grow (non-positive reduction)', () => {
    const { dispatch, existingPositions } = shrinkDispatch(
      [{ id: loanId(0n, 0n), principal: 1_000000n }],
      { id: loanId(0n, 60n), size: 5_000000n },
    )
    const result = evaluateNettedShrinkEligibility({ dispatch, existingPositions })
    expect(result).toMatchObject({ eligible: false, reason: 'non-positive-reduction' })
  })

  it('rejects a strike-converted loan (asset !== tokenType)', () => {
    const converted = createTokenIdBuilder(POOL_ID)
      .addLoan({ asset: 0n, tokenType: 1n, strike: 0n })
      .build()
    const { dispatch, existingPositions } = shrinkDispatch(
      [{ id: converted, principal: 2_000000n }],
      { id: loanId(1n, 60n), size: 1_000000n },
    )
    const result = evaluateNettedShrinkEligibility({ dispatch, existingPositions })
    expect(result).toMatchObject({ eligible: false, reason: 'not-borrowed-token-denominated' })
  })

  it('rejects a multi-leg (mixed) burned position', () => {
    const mixed = createTokenIdBuilder(POOL_ID)
      .addLoan({ asset: 0n, tokenType: 0n, strike: 0n })
      .addLeg({ asset: 0n, tokenType: 0n, strike: 60n, width: 10n, optionRatio: 1n, isLong: false })
      .build()
    const { dispatch, existingPositions } = shrinkDispatch([{ id: mixed, principal: 2_000000n }], {
      id: loanId(0n, 60n),
      size: 1_000000n,
    })
    const result = evaluateNettedShrinkEligibility({ dispatch, existingPositions })
    expect(result).toMatchObject({ eligible: false, reason: 'multi-leg-loan' })
  })

  it('rejects loans on different sides', () => {
    const { dispatch, existingPositions } = shrinkDispatch(
      [
        { id: loanId(0n, 0n), principal: 10_000000n },
        { id: loanId(1n, 0n), principal: 6_000000n },
      ],
      { id: loanId(0n, 60n), size: 4_000000n },
    )
    const result = evaluateNettedShrinkEligibility({ dispatch, existingPositions })
    expect(result).toMatchObject({ eligible: false, reason: 'mixed-pool-or-side' })
  })
})

describe('buildNettedShrinkDispatch', () => {
  it('wraps the restructuring in a temporary loan and swaps only the net', () => {
    const oldLoan = loanId(0n, 0n)
    const replacement = loanId(0n, 60n)
    const { dispatch, existingPositions } = shrinkDispatch(
      [{ id: oldLoan, principal: 14_673_626745n }],
      { id: replacement, size: 13_415_188888n },
    )

    const candidate = buildNettedShrinkDispatch({
      dispatch,
      existingPositions,
      currentTick: TICK,
      slippageBps: 100n,
    })

    expect(candidate.amountOut).toBe(1_258_437857n)

    const temp = candidate.temporaryLoan.tokenId
    const list = candidate.dispatch.positionIdList
    // 4 ops: temp mint, replacement mint, old burn, temp burn.
    expect(list).toEqual([temp, replacement, oldLoan, temp])
    // Temp loan minted (size>0) then burned (size 0); absent from the final list.
    expect(candidate.dispatch.positionSizes[0]).toBeGreaterThan(0n)
    expect(candidate.dispatch.positionSizes.at(-1)).toBe(0n)
    expect(candidate.dispatch.finalPositionIdList).toEqual([replacement])
    expect(candidate.dispatch.finalPositionIdList).not.toContain(temp)

    const limits = candidate.dispatch.tickAndSpreadLimits
    const FULL_RANGE = [BigInt(MIN_TICK), BigInt(MAX_TICK), 0n]
    // Temp mint AND inner ops: full-range no-swap band (a narrow band on a
    // no-swap mint can PriceBoundFail when the tick drifts before inclusion).
    expect(limits[0]).toEqual(FULL_RANGE)
    expect(limits[1]).toEqual(FULL_RANGE)
    expect(limits[2]).toEqual(FULL_RANGE)
    // Temp burn: narrow descending band (the only swap).
    const tempBurnLimit = limits[limits.length - 1]
    expect(tempBurnLimit[0] > tempBurnLimit[1]).toBe(true)
    expect(tempBurnLimit).not.toEqual(FULL_RANGE)
  })

  it('mints the replacement before burning the original (fund repayment first)', () => {
    const oldLoan = loanId(0n, 0n)
    const replacement = loanId(0n, 60n)
    const { dispatch, existingPositions } = shrinkDispatch(
      [{ id: oldLoan, principal: 14_673_626745n }],
      { id: replacement, size: 13_415_188888n },
    )
    const candidate = buildNettedShrinkDispatch({
      dispatch,
      existingPositions,
      currentTick: TICK,
      slippageBps: 100n,
    })
    const list = candidate.dispatch.positionIdList
    expect(list.indexOf(replacement)).toBeLessThan(list.indexOf(oldLoan))
  })

  it('honors a grown loanAmount override for share-boundary retries', () => {
    const { dispatch, existingPositions } = shrinkDispatch(
      [{ id: loanId(0n, 0n), principal: 14_673_626745n }],
      { id: loanId(0n, 60n), size: 13_415_188888n },
    )
    const grown = nextTemporaryLoanAmount(1_258_437857n, 0n)
    expect(grown).toBeGreaterThan(1_258_437857n)
    const candidate = buildNettedShrinkDispatch({
      dispatch,
      existingPositions,
      currentTick: TICK,
      slippageBps: 100n,
      loanAmount: grown,
    })
    // The swap stays the net reduction; only the borrowed principal grows.
    expect(candidate.amountOut).toBe(1_258_437857n)
    expect(candidate.temporaryLoan.amount).toBe(grown)
  })
})

describe('nextTemporaryLoanAmount', () => {
  it('advances by at least ~5% even when residual is zero', () => {
    expect(nextTemporaryLoanAmount(1000n, 0n)).toBe(1050n)
  })
  it('advances by the residual when it exceeds the geometric step', () => {
    expect(nextTemporaryLoanAmount(1000n, 500n)).toBe(1500n)
  })
})
