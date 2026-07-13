import type { PublicClient } from 'viem'

import type { HedgerBotConfig } from '../config'
import { createCexSource } from './cexSource'
import { createPoolTickSource } from './poolTickSource'
import type { PriceSignalSource } from './types'
import { createUniswapPoolSource } from './uniswapPoolSource'

export { createPoolTickSource } from './poolTickSource'
export { type PriceSignal, type PriceSignalSource, PriceSignalUnavailableError } from './types'

export interface CreatePriceSignalSourceDeps {
  publicClient: PublicClient
  /** Options pool token decimals — required by the cex source to build a tick. */
  token0Decimals?: bigint
  token1Decimals?: bigint
  /**
   * Which pool token is ETH (0 ⇒ token0, 1 ⇒ token1) — required by the cex source
   * to orient the USD price into the pool's tick. Derived from the pool's token
   * symbols (the non-stable side), NOT from ASSET_INDEX.
   */
  ethTokenIndex?: 0n | 1n
}

/** Select and construct the configured price signal source. */
export function createPriceSignalSource(
  config: HedgerBotConfig,
  deps: CreatePriceSignalSourceDeps,
): PriceSignalSource {
  const chainId = BigInt(config.CHAIN_ID)

  switch (config.PRICE_SIGNAL_SOURCE) {
    case 'pool-tick':
      return createPoolTickSource({
        publicClient: deps.publicClient,
        poolAddress: config.POOL_ADDRESS,
        chainId,
      })
    case 'uniswap-pool':
      return createUniswapPoolSource({
        publicClient: deps.publicClient,
        version: config.UNISWAP_SIGNAL_POOL_VERSION,
        poolAddress: config.UNISWAP_SIGNAL_POOL_ADDRESS,
        stateViewAddress: config.UNISWAP_SIGNAL_STATE_VIEW_ADDRESS,
        poolId: config.UNISWAP_SIGNAL_POOL_ID,
      })
    case 'cex': {
      if (deps.token0Decimals === undefined || deps.token1Decimals === undefined) {
        throw new Error('cex signal requires token0Decimals/token1Decimals (from pool metadata)')
      }
      if (deps.ethTokenIndex === undefined) {
        throw new Error('cex signal requires ethTokenIndex (which pool token is ETH)')
      }
      // The aggregator's exchange subscriptions are hardcoded to ETH/USD(T).
      // Fail loudly rather than silently hedging a non-ETH pool with ETH prices.
      if (config.CEX_SYMBOL && !/^ETH[-/]?USD[TC]?$/i.test(config.CEX_SYMBOL)) {
        throw new Error(
          `CEX_SYMBOL '${config.CEX_SYMBOL}' is not supported: the cex aggregator feeds are hardcoded to ETH/USD(T)`,
        )
      }
      return createCexSource({
        token0Decimals: deps.token0Decimals,
        token1Decimals: deps.token1Decimals,
        ethTokenIndex: deps.ethTokenIndex,
        staleMs: config.CEX_STALE_MS,
        minFeeds: config.CEX_MIN_FEEDS,
      })
    }
    default: {
      const _exhaustive: never = config.PRICE_SIGNAL_SOURCE
      throw new Error(`unsupported PRICE_SIGNAL_SOURCE: ${String(_exhaustive)}`)
    }
  }
}
