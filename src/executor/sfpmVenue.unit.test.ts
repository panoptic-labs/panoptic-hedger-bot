import { describe, expect, it } from 'vitest'

import { sfpmVenueSavingsBps, shouldUseSfpmVenue } from './sfpmVenue'

describe('sfpmVenueSavingsBps', () => {
  it('is positive when the SFPM venue delivers more output', () => {
    // 30bps path ~ 1000 out, 5bps path ~ 1002.5 out → ~25 bps saving
    expect(sfpmVenueSavingsBps(1_000_000n, 1_002_500n)).toBe(25n)
  })

  it('is negative when the SFPM venue is worse (thin liquidity)', () => {
    expect(sfpmVenueSavingsBps(1_000_000n, 998_000n)).toBe(-20n)
  })

  it('returns 0 for a non-positive in-pool reference', () => {
    expect(sfpmVenueSavingsBps(0n, 500n)).toBe(0n)
  })
})

describe('shouldUseSfpmVenue', () => {
  it('routes off-venue only when the saving clears the threshold', () => {
    expect(
      shouldUseSfpmVenue({
        inPoolAmountOut: 1_000_000n,
        sfpmAmountOut: 1_002_500n,
        minSavingsBps: 5n,
      }),
    ).toBe(true)
    expect(
      shouldUseSfpmVenue({
        inPoolAmountOut: 1_000_000n,
        sfpmAmountOut: 1_000_300n,
        minSavingsBps: 5n,
      }),
    ).toBe(false)
  })

  it('stays in-pool when the SFPM venue is worse', () => {
    expect(
      shouldUseSfpmVenue({
        inPoolAmountOut: 1_000_000n,
        sfpmAmountOut: 995_000n,
        minSavingsBps: 5n,
      }),
    ).toBe(false)
  })
})
