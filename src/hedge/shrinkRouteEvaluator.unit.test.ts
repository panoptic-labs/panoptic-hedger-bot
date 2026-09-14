import { createTokenIdBuilder, decodeTokenId } from '@panoptic-eng/sdk/v2'
import { describe, expect, it, vi } from 'vitest'

import type { DispatchArgsPreview, HedgeIntent } from '../executor/types'
import type { NettedShrinkPosition } from './nettedShrink'
import { type NettedShrinkResolverDeps, resolveNettedShrinkDispatch } from './shrinkRouteEvaluator'

const POOL_ID = (60n << 48n) | 0x1234abcdn
const POOL = '0x0000000000000000000000000000000000000001' as const
const TICK = 198_193n

function loanId(strike: bigint, optionRatio = 1n): bigint {
  return createTokenIdBuilder(POOL_ID)
    .addLoan({ asset: 0n, tokenType: 0n, strike, optionRatio })
    .build()
}

const oldLoan = loanId(0n)
const replacement = loanId(60n)

const intent: HedgeIntent = {
  action: 'shrink',
  openTokenId: replacement,
  openPositionSize: 13_415_188888n,
  swapAtMint: true,
  closeTokenIds: [oldLoan],
  existingPositionIds: [oldLoan],
  skippedCollidingTokenIds: [],
  currentTick: TICK,
  slippageBps: 100n,
}

const existingPositions: NettedShrinkPosition[] = [
  { tokenId: oldLoan, legs: decodeTokenId(oldLoan).legs, positionSize: 14_673_626745n },
]

const ok: DispatchArgsPreview = { success: true, margin: {} as never }
// A retryable failure (share-boundary token shortfall) — a bigger loan may fix it.
const reverted: DispatchArgsPreview = {
  success: false,
  reason: 'NotEnoughTokens',
  retryable: true,
}
// A permanent failure — growing the loan cannot help.
const revertedPermanent: DispatchArgsPreview = {
  success: false,
  reason: 'PriceBoundFail(-201377)',
  retryable: false,
}

function makeDeps(over: Partial<NettedShrinkResolverDeps> = {}): NettedShrinkResolverDeps {
  return {
    poolAddress: POOL,
    builderCode: 0n,
    previewDispatchArgs: vi.fn(async () => ok),
    ...over,
  }
}

describe('resolveNettedShrinkDispatch', () => {
  it('returns the 4-op netted dispatch for an eligible shrink that simulates', async () => {
    const dispatch = await resolveNettedShrinkDispatch(intent, existingPositions, TICK, makeDeps())
    expect(dispatch).not.toBeNull()
    // temp mint, replacement mint, old burn, temp burn.
    expect(dispatch?.positionIdList).toHaveLength(4)
    expect(dispatch?.finalPositionIdList).toEqual([replacement])
  })

  it('grows the temporary loan when the first preview reverts, then returns it', async () => {
    let calls = 0
    const previewDispatchArgs = vi.fn(async () => {
      calls += 1
      return calls === 1 ? reverted : ok
    })
    const dispatch = await resolveNettedShrinkDispatch(
      intent,
      existingPositions,
      TICK,
      makeDeps({ previewDispatchArgs }),
    )
    expect(calls).toBeGreaterThanOrEqual(2)
    expect(dispatch).not.toBeNull()
  })

  it('returns null (fallback) when the netted candidate keeps reverting', async () => {
    const previewDispatchArgs = vi.fn(async () => reverted)
    const dispatch = await resolveNettedShrinkDispatch(
      intent,
      existingPositions,
      TICK,
      makeDeps({ previewDispatchArgs }),
    )
    expect(dispatch).toBeNull()
  })

  it('stops after one attempt on a non-retryable revert (no loan growth)', async () => {
    const previewDispatchArgs = vi.fn(async () => revertedPermanent)
    const dispatch = await resolveNettedShrinkDispatch(
      intent,
      existingPositions,
      TICK,
      makeDeps({ previewDispatchArgs }),
    )
    expect(dispatch).toBeNull()
    expect(previewDispatchArgs).toHaveBeenCalledTimes(1) // no wasted retries
  })

  it('returns null for an ineligible (non-reducing) shrink', async () => {
    const growIntent: HedgeIntent = { ...intent, openPositionSize: 20_000_000000n }
    const existing = [
      { tokenId: oldLoan, legs: decodeTokenId(oldLoan).legs, positionSize: 1_000000n },
    ]
    const dispatch = await resolveNettedShrinkDispatch(growIntent, existing, TICK, makeDeps())
    expect(dispatch).toBeNull()
  })
})
