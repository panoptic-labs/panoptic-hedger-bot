import { getUniswapV3PoolInfo, getUniswapV4PoolBasicState } from '@panoptic-eng/sdk/v2'
import type { Address, Hex, PublicClient } from 'viem'

import { asSdkClient } from '../utils/sdkClient'
import { type PriceSignal, type PriceSignalSource, PriceSignalUnavailableError } from './types'

export interface UniswapPoolSourceDeps {
  publicClient: PublicClient
  version: 'v3' | 'v4'
  /** v3: the pool contract address. */
  poolAddress?: Address
  /** v4: the StateView contract + poolId. */
  stateViewAddress?: Address
  poolId?: Hex
  /**
   * If set, `getSignal` throws when the pool's block is older than this many
   * seconds relative to `nowMs()` — matches poolTickSource's staleness guard.
   */
  maxSignalAgeSeconds?: number
  /** Injectable clock for testing. Defaults to Date.now. */
  nowMs?: () => number
}

/**
 * Feature 1 — hedging signal from a DIFFERENT Uniswap pool on the SAME token
 * pair as the options pool (e.g. read the 5bps pool to hedge a 30bps position).
 *
 * Reads current tick via the SDK (getUniswapV3PoolInfo / getUniswapV4PoolBasicState)
 * — never via raw readContract. The tick is directly usable because Uniswap
 * sorts token0 < token1 by address deterministically, so every pool on the same
 * pair (any fee tier, v3 or v4) shares the options pool's token ordering and
 * tick scale. If the signal pool is a DIFFERENT pair/ordering, do not use this.
 */
export function createUniswapPoolSource(deps: UniswapPoolSourceDeps): PriceSignalSource {
  const { publicClient, version, maxSignalAgeSeconds } = deps
  const nowMs = deps.nowMs ?? (() => Date.now())

  function assertFresh(blockTimestampSec: bigint): void {
    if (maxSignalAgeSeconds === undefined) return
    const ageSeconds = nowMs() / 1000 - Number(blockTimestampSec)
    if (ageSeconds > maxSignalAgeSeconds) {
      throw new PriceSignalUnavailableError(
        `uniswap-pool signal is stale: block is ${ageSeconds.toFixed(0)}s old ` +
          `(max ${maxSignalAgeSeconds}s)`,
      )
    }
  }

  return {
    kind: 'uniswap-pool',
    async getSignal(): Promise<PriceSignal> {
      if (version === 'v3') {
        if (!deps.poolAddress) throw new Error('uniswap-pool v3 signal requires poolAddress')
        const info = await getUniswapV3PoolInfo({
          client: asSdkClient<typeof getUniswapV3PoolInfo>(publicClient),
          poolAddress: deps.poolAddress,
        })
        assertFresh(info._meta.blockTimestamp)
        return {
          tick: BigInt(info.currentTick),
          sqrtPriceX96: info.sqrtPriceX96,
          observedAtMs: Number(info._meta.blockTimestamp) * 1000,
          source: 'uniswap-pool',
        }
      }

      if (!deps.stateViewAddress || !deps.poolId) {
        throw new Error('uniswap-pool v4 signal requires stateViewAddress and poolId')
      }
      const state = await getUniswapV4PoolBasicState({
        client: asSdkClient<typeof getUniswapV4PoolBasicState>(publicClient),
        stateViewAddress: deps.stateViewAddress,
        poolId: deps.poolId,
      })
      assertFresh(state._meta.blockTimestamp)
      return {
        tick: BigInt(state.currentTick),
        sqrtPriceX96: state.sqrtPriceX96,
        observedAtMs: Number(state._meta.blockTimestamp) * 1000,
        source: 'uniswap-pool',
      }
    },
  }
}
