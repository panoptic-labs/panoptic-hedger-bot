import { describe, expect, it } from 'vitest'

import type { HedgeSnapshot } from '../hedge/snapshot'
import {
  findDriftBoundaries,
  formatHedgeTriggerStatus,
  hedgeMonitorMode,
} from './hedgeTriggerMonitor'

describe('findDriftBoundaries', () => {
  it('finds the first strictly-triggered tick in both directions', () => {
    const driftAt = (tick: bigint) => (tick < 0n ? -tick : tick)

    expect(findDriftBoundaries(0n, 300n, driftAt)).toEqual({ down: -301n, up: 301n })
  })

  it('preserves the strict threshold boundary', () => {
    const driftAt = (tick: bigint) => tick

    expect(findDriftBoundaries(100n, 300n, driftAt)).toEqual({ up: 301n })
  })

  it('reports the current tick when the cached snapshot is already beyond the threshold', () => {
    expect(findDriftBoundaries(42n, 300n, () => 301n)).toEqual({ down: 42n, up: 42n })
  })
})

describe('hedgeMonitorMode', () => {
  const snapshotWith = (isLong: boolean[]) =>
    ({
      positions: isLong.map((direction, index) => ({
        tokenId: BigInt(index + 1),
        positionSize: 1n,
        tickAtMint: 0n,
        legs: [{ width: 1n, isLong: direction }],
      })),
      lp: { positions: [{ liquidity: 1n, tickLower: -10n, tickUpper: 10n }] },
    }) as HedgeSnapshot

  it('uses local evaluation for mixed option gamma', () => {
    expect(hedgeMonitorMode(snapshotWith([true, false]), false)).toBe('local-eval')
  })

  it('uses local evaluation when long option and included LP gamma can oppose', () => {
    expect(hedgeMonitorMode(snapshotWith([true]), true)).toBe('local-eval')
  })

  it('keeps a short-only book on simple boundaries when LP delta is included', () => {
    expect(hedgeMonitorMode(snapshotWith([false]), true)).toBe('boundaries')
  })
})

describe('formatHedgeTriggerStatus', () => {
  const priceContext = {
    token0Decimals: 18n,
    token1Decimals: 18n,
    token0Symbol: 'TOKEN0',
    token1Symbol: 'TOKEN1',
  }

  it('prints the hard up/down prices and approach prices with explicit labels', () => {
    expect(
      formatHedgeTriggerStatus(
        {
          mode: 'boundaries',
          snapshotBlock: 123n,
          snapshotTick: 0n,
          latestTick: 0n,
          driftBps: 91n,
          triggerDown: -100n,
          triggerUp: 100n,
          approachDown: -50n,
          approachUp: 50n,
        },
        priceContext,
      ),
    ).toBe(
      'hedge-trigger prices mode=boundaries pair=TOKEN1/TOKEN0 current=1.000000 down=0.990050 up=1.010050 approachDown=0.995013 approachUp=1.005012',
    )
  })

  it('makes dynamic local evaluation explicit when fixed ticks are unavailable', () => {
    expect(
      formatHedgeTriggerStatus(
        {
          mode: 'local-eval',
          snapshotBlock: 123n,
          snapshotTick: 0n,
          latestTick: 0n,
          driftBps: 91n,
        },
        priceContext,
      ),
    ).toContain('mode=local-eval pair=TOKEN1/TOKEN0 current=1.000000 down=none up=none')
  })
})
