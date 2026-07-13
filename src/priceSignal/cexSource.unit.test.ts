import { describe, expect, it, vi } from 'vitest'

import type { HedgerBotConfig } from '../config'
import type { AggregatedPrice, LatestPriceProvider } from './cexAggregator'
import { createCexSource } from './cexSource'
import { createPriceSignalSource } from './index'

function fakeProvider(latest: AggregatedPrice | null): LatestPriceProvider {
  return { start: vi.fn(), stop: vi.fn(), getLatest: () => latest }
}

const priced = (price: number, ts: number): AggregatedPrice => ({
  price,
  method: 'median',
  ts,
  contributingExchanges: ['binance'],
  droppedExchanges: [],
  readings: [{ exchange: 'binance', mid: price }],
})

// WETH(18)/USDC(6): asset=token0 ⇒ USD-per-ETH is the token1/token0 price.
const WETH_USDC = { token0Decimals: 18n, token1Decimals: 6n }

describe('createCexSource', () => {
  it('starts the provider on construction', () => {
    const provider = fakeProvider(null)
    createCexSource({ ...WETH_USDC, ethTokenIndex: 0n, staleMs: 12_000, minFeeds: 1, provider })
    expect(provider.start).toHaveBeenCalledTimes(1)
  })

  it('throws when there is no aggregate yet', async () => {
    const src = createCexSource({
      ...WETH_USDC,
      ethTokenIndex: 0n,
      staleMs: 12_000,
      minFeeds: 1,
      provider: fakeProvider(null),
    })
    await expect(src.getSignal()).rejects.toThrow(/no aggregated price/)
  })

  it('throws when the aggregate is stale', async () => {
    const now = 1_000_000
    const src = createCexSource({
      ...WETH_USDC,
      ethTokenIndex: 0n,
      staleMs: 12_000,
      minFeeds: 1,
      nowMs: () => now,
      provider: fakeProvider(priced(3000, now - 20_000)),
    })
    await expect(src.getSignal()).rejects.toThrow(/stale/)
  })

  it('converts a fresh USD price to a tick (asset=token0 uses price directly)', async () => {
    const now = 1_000_000
    const src = createCexSource({
      ...WETH_USDC,
      ethTokenIndex: 0n,
      staleMs: 12_000,
      minFeeds: 1,
      nowMs: () => now,
      provider: fakeProvider(priced(3000, now - 1_000)),
    })
    const signal = await src.getSignal()
    expect(signal.source).toBe('cex')
    expect(signal.observedAtMs).toBe(now - 1_000)
    // ETH ~ $3000: the WETH/USDC tick is a large negative number (~ -196000).
    expect(signal.tick).toBeLessThan(0n)
    expect(typeof signal.tick).toBe('bigint')
  })

  it('rejects a non-ETH CEX_SYMBOL — the aggregator feeds are hardcoded to ETH/USD', () => {
    const config = {
      CHAIN_ID: 1,
      PRICE_SIGNAL_SOURCE: 'cex',
      ASSET_INDEX: 0n,
      CEX_SYMBOL: 'BTCUSDT',
      CEX_STALE_MS: 12_000,
      CEX_MIN_FEEDS: 1,
    } as unknown as HedgerBotConfig
    expect(() =>
      createPriceSignalSource(config, {
        publicClient: {} as never,
        token0Decimals: 18n,
        token1Decimals: 6n,
        ethTokenIndex: 0n,
      }),
    ).toThrow(/hardcoded to ETH/)
  })

  it('inverts the price when the asset is token1', async () => {
    const now = 1_000_000
    const provider = fakeProvider(priced(3000, now - 1_000))
    // asset=token1: token0 is the USD side (USDC 6dec), token1 is ETH (18dec).
    const src = createCexSource({
      token0Decimals: 6n,
      token1Decimals: 18n,
      ethTokenIndex: 1n,
      staleMs: 12_000,
      minFeeds: 1,
      nowMs: () => now,
      provider,
    })
    const signal = await src.getSignal()
    // Inverse ordering ⇒ tick has the opposite sign region (large positive).
    expect(signal.tick).toBeGreaterThan(0n)
  })
})
