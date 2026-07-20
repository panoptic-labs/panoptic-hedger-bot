import * as sdk from '@panoptic-eng/sdk/v2'
import type { Address, PublicClient } from 'viem'
import { afterEach, describe, expect, it, vi } from 'vitest'

import { createPoolTickSource } from './poolTickSource'

const POOL: Address = '0x2222222222222222222222222222222222222222'
const CHAIN_ID = 1n
const BLOCK_TS = 1_700_000_000n // unix seconds

function mockGetOracleState() {
  return vi.spyOn(sdk, 'getOracleState').mockResolvedValue({
    medianTick: 12345n,
    referenceTick: 12350n,
    _meta: { blockTimestamp: BLOCK_TS, blockNumber: 1n, blockHash: '0x' },
  } as never)
}

const publicClient = { getBlockNumber: async () => 1n } as PublicClient

afterEach(() => {
  vi.restoreAllMocks()
})

describe('poolTickSource.getSignal', () => {
  it('returns the pool spot (reference) tick with block-timestamp observedAtMs', async () => {
    mockGetOracleState()
    const source = createPoolTickSource({ publicClient, poolAddress: POOL, chainId: CHAIN_ID })
    const signal = await source.getSignal()
    expect(signal.source).toBe('pool-tick')
    // Uses referenceTick (pool spot), NOT medianTick, so delta hedging tracks live exposure.
    expect(signal.tick).toBe(12350n)
    expect(typeof signal.sqrtPriceX96).toBe('bigint')
    expect(signal.blockNumber).toBe(1n)
    expect(signal.observedAtMs).toBe(Number(BLOCK_TS) * 1000)
  })

  it('throws when the block is older than maxSignalAgeSeconds', async () => {
    mockGetOracleState()
    const source = createPoolTickSource({
      publicClient,
      poolAddress: POOL,
      chainId: CHAIN_ID,
      maxSignalAgeSeconds: 120,
      // 10 minutes after the block => stale
      nowMs: () => Number(BLOCK_TS) * 1000 + 600_000,
    })
    await expect(source.getSignal()).rejects.toThrow(/stale/)
  })

  it('passes freshness when within maxSignalAgeSeconds', async () => {
    mockGetOracleState()
    const source = createPoolTickSource({
      publicClient,
      poolAddress: POOL,
      chainId: CHAIN_ID,
      maxSignalAgeSeconds: 120,
      nowMs: () => Number(BLOCK_TS) * 1000 + 30_000,
    })
    await expect(source.getSignal()).resolves.toMatchObject({ tick: 12350n })
  })
})
