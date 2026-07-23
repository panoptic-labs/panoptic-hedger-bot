/**
 * Uniswap LP-delta fold, end-to-end against the REAL mainnet Panoptic pool on
 * an anvil fork.
 *
 * The mainnet pool (0x…563b) is a Uniswap v4 native-ETH/USDC pool. This suite
 * proves the parts of the LP path that unit tests can't, because they depend on
 * live on-chain state:
 *   1. readHedgeSnapshot filters the (stubbed) subgraph positions against the
 *      REAL pool.poolKey pair — dropping a same-numeraire WBTC/USDC position.
 *   2. The freshness guard (headBlock vs chain head, maxLagBlocks) flips
 *      snapshot.lp.fresh, which gates whether LP delta is folded.
 *   3. computeHedgePlan folds lpDelta at the pool's LIVE currentTick, matching a
 *      direct getLpGreeks recomputation, and only when includeLp is set.
 *
 * The subgraph is stubbed with CAPTURED real positions (fetched from the live
 * Goldsky LP subgraph) so the test is deterministic and needs no network.
 *
 * Prerequisites (fork at a block where the pool is ACTIVE):
 *   1. anvil --fork-url $MAINNET_RPC_URL --port 8546
 *   2. export HEDGER_FORK_RPC_URL=http://127.0.0.1:8546
 *   3. pnpm -C apps/hedger-bot security:test-fork
 */

import { getLpGreeks } from '@panoptic-eng/sdk/uniswap'
import { createMemoryStorage, getPool } from '@panoptic-eng/sdk/v2'
import { type PublicClient, createPublicClient, http } from 'viem'
import { mainnet } from 'viem/chains'
import { beforeAll, describe, expect, it } from 'vitest'

import { computeHedgePlan } from '../src/hedge/decision'
import type { LpPositionForHedge } from '../src/hedge/lpPositions'
import { readHedgeSnapshot } from '../src/hedge/snapshot'
import { asSdkClient } from '../src/utils/sdkClient'

const RPC_URL = process.env.HEDGER_FORK_RPC_URL
if (!RPC_URL) {
  throw new Error(
    'HEDGER_FORK_RPC_URL is required; start a pinned mainnet fork before running security:test-fork',
  )
}
const CHAIN_ID = 1n
const POOL_ADDRESS = '0x00000000563b70d704f4c6675a5f6ac989fbae13' as `0x${string}`

const ETH = '0x0000000000000000000000000000000000000000'
const USDC = '0xa0b86991c6218b36c1d19d4a2e9eb0ce3606eb48'
const WBTC = '0x2260fac5e5542a773aa44fbcfedf7c193bc2c599'

// Real open ETH/USDC v4 positions captured from the live LP subgraph
// (ids v4-71998, v4-307579). Same pair as the Panoptic pool → must be kept.
const ETH_USDC_A = {
  liquidity: '3290742375047007364',
  tickLower: '-193320',
  tickUpper: '-191100',
  pool: { token0: { id: ETH }, token1: { id: USDC } },
}
const ETH_USDC_B = {
  liquidity: '1262822261801522134',
  tickLower: '-203160',
  tickUpper: '-200820',
  pool: { token0: { id: ETH }, token1: { id: USDC } },
}
// Real WBTC/USDC position — right numeraire (USDC) but wrong pair → dropped.
const WBTC_USDC = {
  liquidity: '203336416',
  tickLower: '68040',
  tickUpper: '72120',
  pool: { token0: { id: WBTC }, token1: { id: USDC } },
}

// An arbitrary EOA that holds no Panoptic positions on this pool; used as the
// snapshot's account so the on-chain position/collateral reads come back empty
// and the LP delta is the whole story.
const SAFE = '0x000000000000000000000000000000000000dEaD' as `0x${string}`
const ASSET_INDEX = 0n // native ETH is the option-sizing (volatile) asset

/** A subgraph fetch stub returning the given positions for any owner. */
function subgraphStub(positions: unknown[], headBlock: bigint): typeof fetch {
  return (async () =>
    ({
      ok: true,
      json: async () => ({
        data: {
          _meta: { block: { number: Number(headBlock) } },
          account: { lpPositions: positions },
        },
      }),
    }) as Response) as unknown as typeof fetch
}

describe('hedger-bot Uniswap LP fold end-to-end (mainnet fork)', () => {
  let publicClient: PublicClient
  let pool: Awaited<ReturnType<typeof getPool>>
  let forkBlock: bigint

  beforeAll(async () => {
    publicClient = createPublicClient({ chain: mainnet, transport: http(RPC_URL), cacheTime: 0 })
    forkBlock = await publicClient.getBlockNumber().catch(() => {
      throw new Error(`fork unreachable at ${RPC_URL}`)
    })
    pool = await getPool({
      client: asSdkClient<typeof getPool>(publicClient),
      poolAddress: POOL_ADDRESS,
      chainId: CHAIN_ID,
      blockNumber: forkBlock,
    })
    // Sanity: this suite's captured data assumes the native-ETH/USDC pair.
    expect(pool.poolKey.currency0.toLowerCase()).toBe(ETH)
    expect(pool.poolKey.currency1.toLowerCase()).toBe(USDC)
  })

  const snapshotWith = (positions: unknown[], headBlock: bigint) =>
    readHedgeSnapshot({
      publicClient,
      poolAddress: POOL_ADDRESS,
      chainId: CHAIN_ID,
      safeAddress: SAFE,
      blockNumber: forkBlock,
      // Tiny scan window: the dead account holds nothing, so no events to find.
      fromBlock: forkBlock - 5n,
      storage: createMemoryStorage(),
      lp: {
        subgraphUrl: 'http://subgraph.local',
        owners: [SAFE],
        maxLagBlocks: 50n,
        fetcher: subgraphStub(positions, headBlock),
      },
    })

  const expectedLpDelta = (positions: LpPositionForHedge[]): bigint =>
    positions.reduce(
      (sum, lp) =>
        sum +
        getLpGreeks({
          liquidity: lp.liquidity,
          tickLower: lp.tickLower,
          tickUpper: lp.tickUpper,
          currentTick: pool.currentTick,
          assetIndex: ASSET_INDEX === 0n ? 0 : 1,
        }).delta,
      0n,
    )

  it('keeps only same-pair positions (dropping WBTC/USDC) against the real pool pair', async () => {
    const snapshot = await snapshotWith([ETH_USDC_A, WBTC_USDC, ETH_USDC_B], forkBlock)
    expect(snapshot.lp?.positions).toEqual([
      { liquidity: 3290742375047007364n, tickLower: -193320n, tickUpper: -191100n },
      { liquidity: 1262822261801522134n, tickLower: -203160n, tickUpper: -200820n },
    ])
  })

  it('folds LP delta at the live pool tick when the subgraph is fresh', async () => {
    const snapshot = await snapshotWith([ETH_USDC_A, ETH_USDC_B], forkBlock)
    expect(snapshot.lp?.fresh).toBe(true)
    expect(snapshot.positions).toHaveLength(0) // dead account: LP delta is the whole story

    const includeLp = snapshot.lp?.fresh ?? false
    const plan = computeHedgePlan({
      pool: snapshot.pool,
      collateral: snapshot.collateral,
      signalTick: snapshot.pool.currentTick,
      assetIndex: ASSET_INDEX,
      deltaThresholdBps: 200n,
      deltaOffsetBps: 0n,
      absoluteMaxHedgeCount: 10,
      slippageBps: 50n,
      positions: snapshot.positions,
      hedgePositions: snapshot.hedgePositions,
      lpPositions: snapshot.lp?.positions,
      includeLp,
    })

    const expected = expectedLpDelta(snapshot.lp?.positions ?? [])
    expect(expected).not.toBe(0n)
    expect(plan.breakdown.lpDelta).toBe(expected)
    expect(plan.breakdown.lpIncluded).toBe(true)
    // Dead account ⇒ positions/collateral deltas are 0, so netDelta IS lpDelta.
    expect(plan.netDelta).toBe(expected)
  })

  it('forces observe-only when the subgraph lags beyond maxLagBlocks', async () => {
    const staleHead = forkBlock - 5_000n // > maxLagBlocks (50) behind chain head
    const snapshot = await snapshotWith([ETH_USDC_A, ETH_USDC_B], staleHead)
    expect(snapshot.lp?.fresh).toBe(false)

    const includeLp = snapshot.lp?.fresh ?? false
    const plan = computeHedgePlan({
      pool: snapshot.pool,
      collateral: snapshot.collateral,
      signalTick: snapshot.pool.currentTick,
      assetIndex: ASSET_INDEX,
      deltaThresholdBps: 200n,
      deltaOffsetBps: 0n,
      absoluteMaxHedgeCount: 10,
      slippageBps: 50n,
      positions: snapshot.positions,
      hedgePositions: snapshot.hedgePositions,
      lpPositions: snapshot.lp?.positions,
      includeLp,
    })

    // Delta is still COMPUTED for reporting, but NOT applied to netDelta.
    expect(plan.breakdown.lpDelta).toBe(expectedLpDelta(snapshot.lp?.positions ?? []))
    expect(plan.breakdown.lpIncluded).toBe(false)
    expect(plan.netDelta).toBe(0n)
  })
})
