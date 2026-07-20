import { getOracleState, tickToSqrtPriceX96 } from '@panoptic-eng/sdk/v2'
import type { Address, PublicClient } from 'viem'

import { asSdkClient } from '../utils/sdkClient'
import type { PriceSignal, PriceSignalSource } from './types'

export interface PoolTickSourceDeps {
  publicClient: PublicClient
  /** PanopticPool the options + hedge loans live in. */
  poolAddress: Address
  chainId: bigint
  /**
   * If set, `getSignal` throws when the pool's block is older than this many
   * seconds relative to `nowMs()` — guards against an RPC serving stale state.
   */
  maxSignalAgeSeconds?: number
  /** Injectable clock for testing. Defaults to Date.now. */
  nowMs?: () => number
}

/**
 * v1 price signal: the Panoptic/Uniswap pool's own on-chain tick, read via the
 * SDK `getPool`. `observedAtMs` is the block timestamp so downstream staleness
 * checks reflect true chain freshness.
 */
export function createPoolTickSource(deps: PoolTickSourceDeps): PriceSignalSource {
  const { publicClient, poolAddress, maxSignalAgeSeconds } = deps
  const nowMs = deps.nowMs ?? (() => Date.now())

  return {
    kind: 'pool-tick',
    async getSignal(): Promise<PriceSignal> {
      const oracle = await getOracleState({
        client: asSdkClient<typeof getOracleState>(publicClient),
        poolAddress,
      })
      const blockTimestampSec = oracle._meta.blockTimestamp
      const observedAtMs = Number(blockTimestampSec) * 1000

      if (maxSignalAgeSeconds !== undefined) {
        const ageSeconds = nowMs() / 1000 - Number(blockTimestampSec)
        if (ageSeconds > maxSignalAgeSeconds) {
          throw new Error(
            `Pool tick signal is stale: block is ${ageSeconds.toFixed(0)}s old ` +
              `(max ${maxSignalAgeSeconds}s) for pool ${poolAddress}`,
          )
        }
      }

      // Use the live pool spot tick (`referenceTick` = pool.currentTick), NOT the
      // median. Delta hedging must neutralize CURRENT price exposure: the median
      // lags spot (median smoothing), and when they diverge (e.g. a persistent
      // ~300-tick gap) near-the-money option legs get marked mid-strike-range,
      // producing partial deltas and a systematically mis-sized hedge. Spot makes
      // the bot's exposure match reality (and the UI).
      const tick = oracle.referenceTick
      return {
        tick,
        sqrtPriceX96: tickToSqrtPriceX96(tick),
        observedAtMs,
        blockNumber: oracle._meta.blockNumber,
        source: 'pool-tick',
        detail: `Panoptic pool spot tick (median reference ${oracle.medianTick})`,
      }
    },
  }
}
