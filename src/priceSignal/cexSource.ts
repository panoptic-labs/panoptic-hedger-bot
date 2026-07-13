import { priceToTick } from '@panoptic-eng/sdk/v2'
import { formatUnits, parseUnits } from 'viem'

import { type LatestPriceProvider, PriceAggregator } from './cexAggregator'
import { type PriceSignal, type PriceSignalSource, PriceSignalUnavailableError } from './types'

export interface CexSourceDeps {
  /** Options pool token decimals, needed to convert a USD price into a tick. */
  token0Decimals: bigint
  token1Decimals: bigint
  /**
   * Which pool token is ETH (the volatile asset the cex feed prices), 0 ⇒ token0,
   * 1 ⇒ token1. This orients the USD price into the pool's token1/token0 tick and
   * is INDEPENDENT of ASSET_INDEX (the delta-accounting frame): the tick fed to
   * dispatch/greeks must always match the pool regardless of how deltas are sized.
   */
  ethTokenIndex: 0n | 1n
  /** Drop the aggregate if older than this many ms. */
  staleMs: number
  minFeeds: number
  nowMs?: () => number
  /** Injectable provider (tests). Defaults to the live multi-exchange aggregator. */
  provider?: LatestPriceProvider
}

/**
 * Feature 2 — hedging signal from an aggregated multi-exchange ETH/USD spot
 * price (see cexAggregator). Converts the USD price into the pool's tick via the
 * SDK `priceToTick` (which already accounts for the token0/token1 decimal gap,
 * e.g. USDC's 6 vs WETH's 18), inverting only when ETH is token1.
 *
 * The aggregator is started on construction so quotes accumulate before the
 * first cycle. `getSignal` throws when there is no fresh aggregate.
 */
export function createCexSource(deps: CexSourceDeps): PriceSignalSource {
  const { token0Decimals, token1Decimals, ethTokenIndex, staleMs, minFeeds } = deps
  const nowMs = deps.nowMs ?? (() => Date.now())
  const provider = deps.provider ?? new PriceAggregator({ staleMs, minFeeds, method: 'median' })

  provider.start()

  return {
    kind: 'cex',
    async getSignal(): Promise<PriceSignal> {
      const latest = provider.getLatest()
      // Warmup / staleness are transient (feeds still connecting) — signal a soft
      // skip so the caller retries next cycle instead of hard-erroring.
      if (!latest) {
        throw new PriceSignalUnavailableError('cex signal: no aggregated price yet (warming up)')
      }
      const age = nowMs() - latest.ts
      if (age > staleMs) {
        throw new PriceSignalUnavailableError(
          `cex signal is stale: ${age}ms old (max ${staleMs}ms)`,
        )
      }
      if (latest.price <= 0) throw new Error('cex signal: non-positive price')

      // priceToTick expects the human price of token1 per token0.
      // ETH=token0 ⇒ token1/token0 = USD per ETH = price (no inversion).
      // ETH=token1 ⇒ token1/token0 = ETH per USD = 1/price (invert).
      // Fix the price to 18 decimals first (guaranteed plain decimal notation),
      // then invert with 1e18 fixed-point bigint math so no intermediate
      // JavaScript float division loses precision before priceToTick.
      const priceScaled = parseUnits(latest.price.toFixed(18), 18) // price × 1e18
      const human =
        ethTokenIndex === 0n ? latest.price.toFixed(18) : formatUnits(10n ** 36n / priceScaled, 18) // (1/price) × 1e18
      const tick = priceToTick(human, token0Decimals, token1Decimals)

      // Raw per-exchange mids + the medianized price, for the log.
      const raw = (latest.readings ?? [])
        .map((r) => `${r.exchange} $${r.mid.toFixed(2)}`)
        .join(', ')
      const dropped =
        latest.droppedExchanges.length > 0
          ? ` (dropped: ${latest.droppedExchanges.join(', ')})`
          : ''
      const detail = `${latest.method} $${latest.price.toFixed(2)} of [${raw}]${dropped}`

      return { tick, observedAtMs: latest.ts, source: 'cex', price: latest.price, detail }
    },
    stop(): void {
      provider.stop()
    },
  }
}
