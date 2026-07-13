import { describe, expect, it } from 'vitest'

import { sizeSpotHedge } from './spotHedge'

// sqrtPriceX96 = 2^96 ⇒ raw price 1 ⇒ numeraireEquiv(x) == x, making the
// direction/slippage logic easy to assert independent of decimals.
const PRICE_ONE = 1n << 96n
const BASE = {
  assetIndex: 0n as const,
  sqrtPriceX96: PRICE_ONE,
  slippageBps: 30n,
  deltaThresholdBps: 200n,
  portfolioSize: 10_000n,
}

describe('sizeSpotHedge', () => {
  it('no swap when drift is below threshold', () => {
    expect(sizeSpotHedge({ ...BASE, netDelta: 100n }).action).toBe('none')
  })

  it('no swap when portfolio size is zero', () => {
    expect(sizeSpotHedge({ ...BASE, netDelta: 9999n, portfolioSize: 0n }).action).toBe('none')
  })

  it('long net delta → sell asset for numeraire', () => {
    const p = sizeSpotHedge({ ...BASE, netDelta: 1000n })
    expect(p.action).toBe('swap')
    expect(p.sellAssetIndex).toBe(0n) // asset
    expect(p.buyAssetIndex).toBe(1n) // numeraire
    expect(p.amountIn).toBe(1000n)
    expect(p.minAmountOut).toBe(997n) // 1000 * (1 - 30bps)
  })

  it('short net delta → buy asset with numeraire', () => {
    const p = sizeSpotHedge({ ...BASE, netDelta: -1000n })
    expect(p.action).toBe('swap')
    expect(p.sellAssetIndex).toBe(1n) // numeraire
    expect(p.buyAssetIndex).toBe(0n) // asset
    expect(p.amountIn).toBe(1000n) // numeraireEquiv at price 1
    expect(p.minAmountOut).toBe(997n)
  })

  it('respects assetIndex=1 (asset is token1)', () => {
    const p = sizeSpotHedge({ ...BASE, assetIndex: 1n, netDelta: 1000n })
    expect(p.sellAssetIndex).toBe(1n)
    expect(p.buyAssetIndex).toBe(0n)
  })
})
