import { describe, expect, it } from 'vitest'

import {
  BUFFER_NO_RISK,
  computeLiquidationBufferBps,
  computeMarginBufferBps,
  DeleverageIncident,
  isDeleverageTriggered,
  selectOptionBurns,
} from './deleverage'
import type { MarginSnapshot } from './marginReserve'

/** Build a two-frame (current, required) margin pair. */
function liq(current0: bigint, required0: bigint, current1: bigint, required1: bigint) {
  return {
    currentMargin0: current0,
    requiredMargin0: required0,
    currentMargin1: current1,
    requiredMargin1: required1,
  }
}

function marginSnapshot(m: ReturnType<typeof liq>): MarginSnapshot {
  return {
    collateralBalance0: m.currentMargin0,
    requiredCollateral0: m.requiredMargin0,
    collateralBalance1: m.currentMargin1,
    requiredCollateral1: m.requiredMargin1,
  }
}

describe('computeLiquidationBufferBps', () => {
  it('is (current - required) / required in bps, min across frames', () => {
    // frame0: excess 2000/req 8000 = 2500bps; frame1: excess 500/req 9500 ≈ 526bps → min 526
    expect(computeLiquidationBufferBps(liq(10_000n, 8_000n, 10_000n, 9_500n))).toBe(
      (500n * 10_000n) / 9_500n,
    )
  })

  it('clamps a shortfall (current < required) to 0', () => {
    expect(computeLiquidationBufferBps(liq(9_000n, 10_000n, 10_000n, 8_000n))).toBe(0n)
  })

  it('returns the no-risk sentinel when there is no margin requirement', () => {
    expect(computeLiquidationBufferBps(liq(10_000n, 0n, 10_000n, 0n))).toBe(BUFFER_NO_RISK)
  })

  it('computeMarginBufferBps mirrors it from a post-dispatch MarginSnapshot', () => {
    const m = liq(10_000n, 8_000n, 10_000n, 8_000n)
    expect(computeMarginBufferBps(marginSnapshot(m))).toBe(computeLiquidationBufferBps(m))
  })
})

describe('isDeleverageTriggered', () => {
  it('fires when liquidatable regardless of buffer', () => {
    expect(
      isDeleverageTriggered({ isLiquidatable: true, bufferBps: 9_000n, triggerMarginBps: 500n }),
    ).toBe(true)
  })

  it('fires when the buffer is strictly below the trigger', () => {
    expect(
      isDeleverageTriggered({ isLiquidatable: false, bufferBps: 499n, triggerMarginBps: 500n }),
    ).toBe(true)
  })

  it('does not fire exactly at the trigger', () => {
    expect(
      isDeleverageTriggered({ isLiquidatable: false, bufferBps: 500n, triggerMarginBps: 500n }),
    ).toBe(false)
  })
})

describe('DeleverageIncident', () => {
  it('opens on trigger and clears only at the target (hysteresis)', () => {
    const incident = new DeleverageIncident(1_500n, 300_000)
    expect(
      incident.observe({ isLiquidatable: false, bufferBps: 400n, triggerMarginBps: 500n }),
    ).toBe(true)
    // Above trigger but below target — stays open.
    expect(
      incident.observe({ isLiquidatable: false, bufferBps: 900n, triggerMarginBps: 500n }),
    ).toBe(true)
    // Reached target — clears.
    expect(
      incident.observe({ isLiquidatable: false, bufferBps: 1_500n, triggerMarginBps: 500n }),
    ).toBe(false)
  })

  it('throttles a stage by the cooldown then allows it again', () => {
    const incident = new DeleverageIncident(1_500n, 300_000)
    expect(incident.canRunStage('loans', 0)).toBe(true)
    incident.markStageRun('loans', 0)
    expect(incident.canRunStage('loans', 299_999)).toBe(false)
    expect(incident.canRunStage('loans', 300_000)).toBe(true)
    // A different stage is independent.
    expect(incident.canRunStage('options', 1)).toBe(true)
  })

  it('resets cooldowns when the incident clears', () => {
    const incident = new DeleverageIncident(1_500n, 300_000)
    incident.observe({ isLiquidatable: false, bufferBps: 400n, triggerMarginBps: 500n })
    incident.markStageRun('loans', 0)
    incident.observe({ isLiquidatable: false, bufferBps: 2_000n, triggerMarginBps: 500n })
    expect(incident.canRunStage('loans', 1)).toBe(true)
  })
})

describe('selectOptionBurns', () => {
  it('returns empty for no candidates', async () => {
    const result = await selectOptionBurns({
      candidates: [],
      targetMarginBps: 1_500n,
      simulate: async () => 9_000n,
    })
    expect(result).toEqual({ tokenIds: [], projectedBufferBps: null, burnedAll: false })
  })

  it('picks the highest close+rehedge-impact single burn when it reaches the target', async () => {
    const single: Record<string, bigint> = { '1': 800n, '2': 1_600n, '3': 600n }
    const result = await selectOptionBurns({
      candidates: [{ tokenId: 1n }, { tokenId: 2n }, { tokenId: 3n }],
      targetMarginBps: 1_500n,
      simulate: async (ids) => (ids.length === 1 ? single[ids[0].toString()] : 2_000n),
    })
    expect(result.tokenIds).toEqual([2n])
    expect(result.burnedAll).toBe(false)
    expect(result.projectedBufferBps).toBe(1_600n)
  })

  it('accumulates greedily until the target is reached', async () => {
    const result = await selectOptionBurns({
      candidates: [{ tokenId: 1n }, { tokenId: 2n }],
      targetMarginBps: 1_500n,
      simulate: async (ids) => (ids.length === 1 ? 800n : 1_600n),
    })
    expect(result.tokenIds).toEqual([1n, 2n])
    expect(result.burnedAll).toBe(false)
    expect(result.projectedBufferBps).toBe(1_600n)
  })

  it('falls back to burning all when no subset reaches the target', async () => {
    const result = await selectOptionBurns({
      candidates: [{ tokenId: 1n }, { tokenId: 2n }],
      targetMarginBps: 5_000n,
      simulate: async () => 800n,
    })
    expect(result.tokenIds).toEqual([1n, 2n])
    expect(result.burnedAll).toBe(true)
  })

  it('ranks reverting candidates (null) last', async () => {
    const result = await selectOptionBurns({
      candidates: [{ tokenId: 1n }, { tokenId: 2n }],
      targetMarginBps: 1_500n,
      simulate: async (ids) => {
        if (ids.length === 1) return ids[0] === 1n ? null : 1_600n
        return 1_600n
      },
    })
    expect(result.tokenIds[0]).toBe(2n)
  })

  it('pre-sorts by |delta| so equal-impact sims keep the biggest-delta option first', async () => {
    // Both singles simulate to the same buffer; the |delta| pre-sort decides order.
    const result = await selectOptionBurns({
      candidates: [
        { tokenId: 1n, absDelta: 10n },
        { tokenId: 2n, absDelta: 500n },
      ],
      targetMarginBps: 1_500n,
      simulate: async (ids) => (ids.length === 1 ? 1_600n : 1_600n),
    })
    expect(result.tokenIds).toEqual([2n])
  })
})
