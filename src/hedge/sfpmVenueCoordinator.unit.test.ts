import type * as SdkV2 from '@panoptic-eng/sdk/v2'
import type { Address } from 'viem'
import { beforeEach, describe, expect, it, vi } from 'vitest'

import type { HedgeIntent } from '../executor/types'
import { buildSwapPoolMapping } from './sfpmVenueRouter'

// Partial-mock the SDK: keep buildBatchDispatchArgs/panopticPoolV2Abi (used by
// buildHedgeBatchOps) real; stub the dispatch sim + the v3 QuoterV2 quote.
const simulateBatchDispatch = vi.fn()
const quoteV3ExactIn = vi.fn()
vi.mock('@panoptic-eng/sdk/v2', async (importActual) => {
  const actual = await importActual<typeof SdkV2>()
  return {
    ...actual,
    simulateBatchDispatch: (...a: unknown[]) => simulateBatchDispatch(...a),
    quoteV3ExactIn: (...a: unknown[]) => quoteV3ExactIn(...a),
  }
})

const { createSfpmVenueCoordinator } = await import('./sfpmVenueCoordinator')

const POOL = '0x00000000563b70d704f4C6675a5f6Ac989FbAe13' as Address
const SWAP_POOL = '0x88e6A0c2dDD26FEEb64F039a2c41296FcB3f5640' as Address
const USDC = '0xA0b86991c6218b36c1d19D4a2e9Eb0cE3606eB48' as Address
const WETH = '0xC02aaA39b223FE8D0A0e5C4F27eAD9083C756Cc2' as Address
const SAFE = '0x1111111111111111111111111111111111111111' as Address

const intent: HedgeIntent = {
  action: 'open',
  openTokenId: 0x2000a0488e6a0c2ddn,
  openPositionSize: 1_000n,
  swapAtMint: true,
  closeTokenIds: [],
  existingPositionIds: [],
  skippedCollidingTokenIds: [],
  currentTick: 201042n,
  slippageBps: 50n,
}
// Options pool (v4): tokenType0 = native ETH, tokenType1 = USDC.
// Swap pool (v3): token0 = USDC, token1 = WETH (flipped ordering).
const mapping = buildSwapPoolMapping({
  optionsAsset0: '0x0000000000000000000000000000000000000000' as Address,
  optionsAsset1: USDC,
  swapToken0: USDC,
  swapToken1: WETH,
  weth9: WETH,
})

const readContract = vi.fn(async () => [0n, 201042, 0, 0, 0, 0, false])
const publicClient = { readContract } as never

function makeCoordinator(minSavingsBps: bigint) {
  return createSfpmVenueCoordinator({
    publicClient,
    poolAddress: POOL,
    safeAddress: SAFE,
    builderCode: 0n,
    chainId: 1n,
    swapPoolAddress: SWAP_POOL,
    swapToken0: USDC,
    swapToken1: WETH,
    swapFee: 500n,
    mapping,
    slippageBps: 50n,
    minSavingsBps,
  })
}

const okQuote = (amountOut: bigint) => ({ amountOut, amountOutMinimum: amountOut, gasEstimate: 0n })

const flow = (delta0: bigint, delta1: bigint) => ({
  success: true,
  tokenFlow: { delta0, delta1 },
})

describe('createSfpmVenueCoordinator', () => {
  beforeEach(() => {
    simulateBatchDispatch.mockReset()
    quoteV3ExactIn.mockReset()
    readContract.mockReset()
    readContract.mockResolvedValue([0n, 201042, 0, 0, 0, 0, false])
  })

  it('sizes the swap from the swapAtMint true−false collateral delta difference', async () => {
    // swapAtMint=true moved -100 token0 (ETH sold) / +190 token1 (USDC bought);
    // swapAtMint=false moved nothing extra → dd0=-100, dd1=+190.
    simulateBatchDispatch.mockResolvedValueOnce(flow(-100n, 190n)) // true
    simulateBatchDispatch.mockResolvedValueOnce(flow(0n, 0n)) // false
    quoteV3ExactIn.mockResolvedValue(okQuote(195n))

    const res = await makeCoordinator(5n).evaluate(intent)
    expect(res).not.toBeNull()
    expect(res?.swapAmount).toBe(100n) // sold side (tokenType0)
    expect(res?.amountOut).toBe(195n) // QuoterV2 output threaded to the executor
    expect(res?.swapPoolTick).toBe(201042)
    // ETH (options token0) sold → v3 token1 (WETH) → sellToken0 = false
    expect(res?.sellToken0).toBe(false)
    // 5bps out 195 vs in-pool 190 → ~263 bps saving > 5 → use
    expect(res?.use).toBe(true)
  })

  it('simulates the no-swap replacement mint before its burns', async () => {
    const replacementIntent = {
      ...intent,
      action: 'shrink' as const,
      closeTokenIds: [11n, 22n],
      existingPositionIds: [11n, 22n],
    }
    simulateBatchDispatch.mockResolvedValueOnce(flow(-100n, 190n))
    simulateBatchDispatch.mockResolvedValueOnce(flow(0n, 0n))
    quoteV3ExactIn.mockResolvedValue(okQuote(195n))

    await makeCoordinator(5n).evaluate(replacementIntent)

    const withSwapItems = simulateBatchDispatch.mock.calls[0][0].items
    const withoutSwapItems = simulateBatchDispatch.mock.calls[1][0].items
    expect(withSwapItems.map((item: { kind: string }) => item.kind)).toEqual([
      'burn',
      'burn',
      'mint',
    ])
    expect(withoutSwapItems.map((item: { kind: string }) => item.kind)).toEqual([
      'mint',
      'burn',
      'burn',
    ])
  })

  it('derives the opposite direction from the delta (sell USDC → v3 token0)', async () => {
    // dd0 = +80 (ETH bought), dd1 = -150 (USDC sold) → sell options token1 (USDC).
    simulateBatchDispatch.mockResolvedValueOnce(flow(80n, -150n))
    simulateBatchDispatch.mockResolvedValueOnce(flow(0n, 0n))
    quoteV3ExactIn.mockResolvedValue(okQuote(85n))
    const res = await makeCoordinator(5n).evaluate(intent)
    expect(res?.swapAmount).toBe(150n) // sold side = USDC
    expect(res?.sellToken0).toBe(true) // USDC is v3 token0
  })

  it('returns null when the delta is not a clean single-direction swap', async () => {
    // both sides same sign → not a swap
    simulateBatchDispatch.mockResolvedValueOnce(flow(-100n, -50n))
    simulateBatchDispatch.mockResolvedValueOnce(flow(0n, 0n))
    expect(await makeCoordinator(5n).evaluate(intent)).toBeNull()
  })

  it('declines when the 5bps saving does not clear the threshold', async () => {
    simulateBatchDispatch.mockResolvedValueOnce(flow(-100n, 190n))
    simulateBatchDispatch.mockResolvedValueOnce(flow(0n, 0n))
    quoteV3ExactIn.mockResolvedValue(okQuote(190n))
    const res = await makeCoordinator(5n).evaluate(intent)
    expect(res?.use).toBe(false)
  })

  it('returns null (stay in-pool) when a dispatch simulation fails', async () => {
    simulateBatchDispatch.mockResolvedValueOnce({ success: false })
    simulateBatchDispatch.mockResolvedValueOnce(flow(0n, 0n))
    expect(await makeCoordinator(5n).evaluate(intent)).toBeNull()
  })

  it('returns null when the imbalance is zero', async () => {
    simulateBatchDispatch.mockResolvedValueOnce(flow(50n, 50n))
    simulateBatchDispatch.mockResolvedValueOnce(flow(50n, 50n)) // no difference
    expect(await makeCoordinator(5n).evaluate(intent)).toBeNull()
  })

  it('returns null when the 5bps pool has no quote (missing/illiquid)', async () => {
    simulateBatchDispatch.mockResolvedValueOnce(flow(-100n, 190n))
    simulateBatchDispatch.mockResolvedValueOnce(flow(0n, 0n))
    quoteV3ExactIn.mockResolvedValue(null)
    expect(await makeCoordinator(5n).evaluate(intent)).toBeNull()
  })

  it('returns null (stay in-pool) when the slot0 read rejects', async () => {
    simulateBatchDispatch.mockResolvedValueOnce(flow(-100n, 190n))
    simulateBatchDispatch.mockResolvedValueOnce(flow(0n, 0n))
    readContract.mockRejectedValueOnce(new Error('rpc down'))
    quoteV3ExactIn.mockResolvedValue(okQuote(195n))
    expect(await makeCoordinator(5n).evaluate(intent)).toBeNull()
  })
})
