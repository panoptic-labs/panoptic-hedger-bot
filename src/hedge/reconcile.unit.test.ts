import { describe, expect, it } from 'vitest'

import type { PositionSnapshot } from './frame'
import { HedgeTracker } from './reconcile'

const loanLeg = { width: 0n } as PositionSnapshot['legs'][number]
const optionLeg = { width: 10n } as PositionSnapshot['legs'][number]

const pos = (tokenId: bigint, legs: PositionSnapshot['legs']): PositionSnapshot => ({
  tokenId,
  legs,
  positionSize: 1n,
  tickAtMint: 0n,
})

describe('HedgeTracker', () => {
  it('seeds from pure loan positions when nothing is tracked yet (restart recovery)', () => {
    const t = new HedgeTracker()
    t.reconcile([pos(1n, [loanLeg]), pos(2n, [optionLeg]), pos(3n, [loanLeg])])
    expect(t.snapshot()).toEqual(new Set([1n, 3n]))
  })

  it('does not re-seed when ids are already tracked', () => {
    const t = new HedgeTracker([1n])
    t.reconcile([pos(1n, [loanLeg]), pos(3n, [loanLeg])])
    // 3n is a loan but tracking is non-empty, so it is not auto-added
    expect(t.snapshot()).toEqual(new Set([1n]))
  })

  it('drops tracked ids that are no longer open', () => {
    const t = new HedgeTracker([1n, 2n])
    t.reconcile([pos(1n, [loanLeg])])
    expect(t.snapshot()).toEqual(new Set([1n]))
  })

  it('applyResult removes burned ids and adds the minted id', () => {
    const t = new HedgeTracker([1n, 2n])
    t.applyResult([1n, 2n], 9n)
    expect(t.snapshot()).toEqual(new Set([9n]))
    expect(t.size).toBe(1)
  })

  it('applyResult with no mint just removes burns', () => {
    const t = new HedgeTracker([1n, 2n])
    t.applyResult([2n], null)
    expect(t.snapshot()).toEqual(new Set([1n]))
  })
})
