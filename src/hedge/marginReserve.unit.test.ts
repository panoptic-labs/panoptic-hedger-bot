import { describe, expect, it } from 'vitest'

import { assessMarginReserve, normalizePostDispatchMargin } from './marginReserve'

describe('normalizePostDispatchMargin', () => {
  it('converts the simulated final state into equivalent token numeraires', () => {
    expect(
      normalizePostDispatchMargin({
        collateral0: 600n,
        collateral1: 400n,
        marginExcess0: 300n,
        marginExcess1: 200n,
        tick: 0n,
      }),
    ).toEqual({
      collateralBalance0: 1_000n,
      requiredCollateral0: 500n,
      collateralBalance1: 1_000n,
      requiredCollateral1: 500n,
    })
  })
})

describe('assessMarginReserve', () => {
  const snapshot = (free: bigint) => ({
    collateralBalance0: 1_000n,
    requiredCollateral0: 1_000n - free,
    collateralBalance1: 2_000n,
    requiredCollateral1: 2_000n - free * 2n,
  })

  it.each([
    [199n, false],
    [200n, true],
    [201n, true],
  ])('checks the just-below/at/above boundary (%s)', (free, sufficient) => {
    expect(assessMarginReserve(snapshot(free), 2_000n, true).sufficient).toBe(sufficient)
  })

  it('requires the reserve in both asset numeraires', () => {
    const result = assessMarginReserve(
      {
        collateralBalance0: 1_000n,
        requiredCollateral0: 800n,
        collateralBalance1: 2_000n,
        requiredCollateral1: 1_601n,
      },
      2_000n,
      true,
    )
    expect(result.sufficient).toBe(false)
    expect(result.reasons).toEqual([expect.stringContaining('token1')])
  })

  it('permits a burn-only risk reduction below the reserve', () => {
    expect(assessMarginReserve(snapshot(0n), 2_000n, false).sufficient).toBe(true)
  })

  it('fails closed for a mint with no collateral', () => {
    expect(
      assessMarginReserve(
        {
          collateralBalance0: 0n,
          requiredCollateral0: 0n,
          collateralBalance1: 0n,
          requiredCollateral1: 0n,
        },
        2_000n,
        true,
      ).sufficient,
    ).toBe(false)
  })
})
