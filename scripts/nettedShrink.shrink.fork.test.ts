/**
 * Netted shrink-and-remint, end-to-end against the REAL mainnet Panoptic pool
 * the bot runs on (0x…9C7B, USDC token0 / WETH token1), on an anvil fork.
 *
 * SYNTHETIC scenario — no real user is referenced. A fresh throwaway EOA deposits
 * USDC + WETH, mints a USDC hedge loan (swapAtMint, so its notional is converted
 * to WETH exposure like a real hedge loan), then we compare two ways to shrink it
 * to a smaller loan:
 *   - the ordinary in-pool dispatch (burn + remint, both swapAtMint): two swaps of
 *     the gross notional;
 *   - the netted dispatch (buildNettedShrinkDispatch): one swap of only the
 *     principal reduction, via a temporary loan.
 * The EOA owns the positions and calls pool.dispatch() itself (no Safe/Roles).
 *
 * Prerequisites (fork at a block where the pool is ACTIVE, isSafeMode=0):
 *   1. anvil --fork-url $MAINNET_RPC_URL --host 127.0.0.1 --port 18547
 *   2. HEDGER_FORK_RPC_URL=http://127.0.0.1:18547 pnpm -C apps/hedger-bot test:shrink-fork
 */
import {
  type BatchDispatchArgs,
  buildBatchDispatchArgs,
  collateralTrackerV2Abi,
  createTokenIdBuilder,
  getAccountCollateral,
  getPositions,
  panopticPoolV2Abi,
  toVaultFrameAtTick,
} from '@panoptic-eng/sdk/v2'
import {
  type PublicClient,
  type WalletClient,
  createPublicClient,
  createTestClient,
  createWalletClient,
  encodeAbiParameters,
  encodeFunctionData,
  http,
  keccak256,
  parseUnits,
} from 'viem'
import { generatePrivateKey, privateKeyToAccount } from 'viem/accounts'
import { mainnet } from 'viem/chains'
import { afterEach, beforeAll, beforeEach, describe, expect, it } from 'vitest'

import { buildHedgeBatchOps } from '../src/executor/dispatchCalldata'
import type { HedgeIntent } from '../src/executor/types'
import { buildNettedShrinkDispatch } from '../src/hedge/nettedShrink'
import { asSdkClient } from '../src/utils/sdkClient'

const RPC_URL = process.env.HEDGER_FORK_RPC_URL
if (!RPC_URL) {
  throw new Error('HEDGER_FORK_RPC_URL is required; start a pinned mainnet fork first')
}

const POOL_ADDRESS = '0x00000000009C7B687e833559e34503f64d7ed7c4' as `0x${string}`
const USDC = '0xA0b86991c6218b36c1d19D4a2e9Eb0cE3606eB48' as `0x${string}`
const WETH = '0xC02aaA39b223FE8D0A0e5C4F27eAD9083C756Cc2' as `0x${string}`
const USDC_BALANCE_SLOT = 9n
const WETH_BALANCE_SLOT = 3n

const DEPOSIT_USDC = parseUnits('200000', 6)
const DEPOSIT_WETH = parseUnits('100', 18)
const OLD_LOAN_USDC = 14_673_626745n // borrowed USDC of the hedge loan being shrunk
const REMINT_USDC = 13_415_188888n // the reduced replacement loan
const SLIPPAGE_BPS = 100n
// Uniswap v3 Swap(address,address,int256,int256,uint160,uint128,int24) topic0.
const UNIV3_SWAP_TOPIC =
  '0xc42079f94a6350d7e6235f29174924f928cc2ac818eb64fed8004e115fbcca67' as const

const erc20Abi = [
  {
    type: 'function',
    name: 'approve',
    stateMutability: 'nonpayable',
    inputs: [
      { name: 'spender', type: 'address' },
      { name: 'value', type: 'uint256' },
    ],
    outputs: [{ type: 'bool' }],
  },
] as const

function keccak256Slot(key: `0x${string}`, slot: bigint): `0x${string}` {
  return keccak256(encodeAbiParameters([{ type: 'address' }, { type: 'uint256' }], [key, slot]))
}

function loanId(poolId: bigint, strike: bigint): bigint {
  return createTokenIdBuilder(poolId)
    .addLoan({ asset: 0n, tokenType: 0n, strike, optionRatio: 1n })
    .build()
}

describe('netted shrink-and-remint (synthetic, mainnet fork)', () => {
  let publicClient: PublicClient
  let testClient: ReturnType<typeof createTestClient>
  let ownerWallet: WalletClient
  const owner = privateKeyToAccount(generatePrivateKey())
  let sdkClient: ReturnType<typeof asSdkClient<typeof getPositions>>
  let ct0: `0x${string}`
  let ct1: `0x${string}`
  let poolId: bigint
  let tickSpacing: bigint
  let markTick: bigint
  let alignedStrike: bigint
  let oldLoan: bigint
  let remintLoan: bigint
  let original: BatchDispatchArgs
  let seedSnapshot: `0x${string}`

  const t = (url: string) => http(url, { timeout: 300_000 })

  function dispatchCalldata(args: BatchDispatchArgs): `0x${string}` {
    return encodeFunctionData({
      abi: panopticPoolV2Abi,
      functionName: 'dispatch',
      args: [
        args.positionIdList,
        args.finalPositionIdList,
        args.positionSizes,
        args.tickAndSpreadLimits.map((v) => [Number(v[0]), Number(v[1]), Number(v[2])]),
        args.usePremiaAsCollateral,
        args.builderCode,
      ],
    })
  }

  async function dispatch(args: BatchDispatchArgs): Promise<`0x${string}`> {
    const data = dispatchCalldata(args)
    // Simulate first so a revert surfaces the real Panoptic error rather than
    // anvil looping on estimateGas until viem times out.
    await publicClient.call({ account: owner.address, to: POOL_ADDRESS, data })
    const hash = await ownerWallet.sendTransaction({
      account: owner,
      chain: mainnet,
      to: POOL_ADDRESS,
      data,
      value: 0n,
      gas: 6_000_000n,
    })
    await testClient.mine({ blocks: 1 })
    return hash
  }

  async function value(who: `0x${string}`): Promise<bigint> {
    const c = await getAccountCollateral({
      client: sdkClient,
      poolAddress: POOL_ADDRESS,
      account: who,
    })
    return c.token0.assets + toVaultFrameAtTick(c.token1.assets, 1n, 0n, markTick)
  }

  async function runRoute(
    args: BatchDispatchArgs,
    // Extra ids to include in the post-dispatch position query — e.g. the netted
    // route's temporary loan, so the "temp loan absent" assertion is meaningful
    // (a leftover temp loan would surface in finalIds rather than be silently
    // excluded from the query).
    alsoQuery: bigint[] = [],
  ): Promise<{ swaps: number; value: bigint; finalIds: bigint[]; gas: bigint }> {
    const snap = (await testClient.snapshot()) as `0x${string}`
    try {
      const hash = await dispatch(args)
      const receipt = await publicClient.getTransactionReceipt({ hash })
      expect(receipt.status).toBe('success')
      const swaps = receipt.logs.filter((l) => l.topics[0] === UNIV3_SWAP_TOPIC).length
      const positions = await getPositions({
        client: sdkClient,
        poolAddress: POOL_ADDRESS,
        owner: owner.address,
        tokenIds: [...args.finalPositionIdList, ...alsoQuery],
      })
      return {
        swaps,
        value: await value(owner.address),
        finalIds: positions.positions.map((p) => p.tokenId).sort(),
        gas: receipt.gasUsed,
      }
    } finally {
      await testClient.revert({ id: snap })
    }
  }

  beforeAll(async () => {
    publicClient = createPublicClient({ chain: mainnet, transport: t(RPC_URL), cacheTime: 0 })
    testClient = createTestClient({ chain: mainnet, mode: 'anvil', transport: t(RPC_URL) })
    ownerWallet = createWalletClient({ account: owner, chain: mainnet, transport: t(RPC_URL) })
    sdkClient = asSdkClient<typeof getPositions>(publicClient)

    await testClient.setBalance({ address: owner.address, value: parseUnits('1000', 18) })

    const { getPool } = await import('@panoptic-eng/sdk/v2')
    const pool = await getPool({
      client: asSdkClient<typeof getPool>(publicClient),
      poolAddress: POOL_ADDRESS,
      chainId: 1n,
    })
    ct0 = pool.collateralTracker0.address
    ct1 = pool.collateralTracker1.address
    poolId = pool.poolId
    tickSpacing = pool.tickSpacing
    markTick = pool.currentTick
    alignedStrike = (pool.currentTick / tickSpacing) * tickSpacing

    // Deal + deposit both collaterals.
    await testClient.setStorageAt({
      address: USDC,
      index: keccak256Slot(owner.address, USDC_BALANCE_SLOT),
      value: `0x${DEPOSIT_USDC.toString(16).padStart(64, '0')}`,
    })
    await testClient.setStorageAt({
      address: WETH,
      index: keccak256Slot(owner.address, WETH_BALANCE_SLOT),
      value: `0x${DEPOSIT_WETH.toString(16).padStart(64, '0')}`,
    })
    for (const [token, ct, amount] of [
      [USDC, ct0, DEPOSIT_USDC],
      [WETH, ct1, DEPOSIT_WETH],
    ] as const) {
      await ownerWallet.writeContract({
        account: owner,
        chain: mainnet,
        address: token,
        abi: erc20Abi,
        functionName: 'approve',
        args: [ct, amount],
      })
      await ownerWallet.writeContract({
        account: owner,
        chain: mainnet,
        address: ct,
        abi: collateralTrackerV2Abi,
        functionName: 'deposit',
        args: [amount, owner.address],
      })
    }

    // Mint the OLD hedge loan (swapAtMint → converts its USDC notional to WETH
    // exposure, like a real hedge loan the bot opens).
    oldLoan = loanId(poolId, alignedStrike)
    remintLoan = loanId(poolId, alignedStrike - tickSpacing)
    const band = { low: markTick - 100n, high: markTick + 100n }
    await dispatch({
      positionIdList: [oldLoan],
      finalPositionIdList: [oldLoan],
      positionSizes: [OLD_LOAN_USDC],
      tickAndSpreadLimits: [[band.high, band.low, 0n]], // descending = swapAtMint
      usePremiaAsCollateral: false,
      builderCode: 0n,
    })

    // The seed mint's swap moved the pool tick. Refresh it so the shrink intent's
    // band, the netted temp-loan band/strike, and the common valuation tick all
    // reflect post-seed state (the block the shrink actually executes from).
    markTick = (
      await getPool({
        client: asSdkClient<typeof getPool>(publicClient),
        poolAddress: POOL_ADDRESS,
        chainId: 1n,
      })
    ).currentTick

    // The ordinary in-pool shrink dispatch (burn old + remint smaller, swapAtMint).
    const intent: HedgeIntent = {
      action: 'shrink',
      openTokenId: remintLoan,
      openPositionSize: REMINT_USDC,
      swapAtMint: true,
      closeTokenIds: [oldLoan],
      existingPositionIds: [oldLoan],
      skippedCollidingTokenIds: [],
      currentTick: markTick,
      slippageBps: SLIPPAGE_BPS,
    }
    const built = buildBatchDispatchArgs({
      items: buildHedgeBatchOps(intent, POOL_ADDRESS),
      existingPositionIds: [oldLoan],
      usePremiaAsCollateral: false,
      builderCode: 0n,
    })
    if (!built.args)
      throw new Error(
        `original build failed: ${built.diagnostics.map((d) => d.message).join('; ')}`,
      )
    original = built.args

    seedSnapshot = (await testClient.snapshot()) as `0x${string}`
    // eslint-disable-next-line no-console
    console.log(
      `[fork] seeded old loan ${OLD_LOAN_USDC} USDC; tick=${markTick} spacing=${tickSpacing}`,
    )
  }, 300_000)

  beforeEach(async () => {
    await testClient.revert({ id: seedSnapshot })
    seedSnapshot = (await testClient.snapshot()) as `0x${string}`
  })
  afterEach(async () => {
    await testClient.revert({ id: seedSnapshot })
    seedSnapshot = (await testClient.snapshot()) as `0x${string}`
  })

  it('nets two gross swaps into one, preserving the final positions', async () => {
    const existingPositions = (
      await getPositions({
        client: sdkClient,
        poolAddress: POOL_ADDRESS,
        owner: owner.address,
        tokenIds: [oldLoan],
      })
    ).positions
    const candidate = buildNettedShrinkDispatch({
      dispatch: original,
      existingPositions,
      currentTick: markTick,
      slippageBps: SLIPPAGE_BPS,
    })
    expect(candidate.amountOut).toBe(OLD_LOAN_USDC - REMINT_USDC)

    const old = await runRoute(original)
    const netted = await runRoute(candidate.dispatch, [candidate.temporaryLoan.tokenId])

    // eslint-disable-next-line no-console
    console.log(
      `[fork] original swaps=${old.swaps} gas=${old.gas} value=${old.value} | ` +
        `netted swaps=${netted.swaps} gas=${netted.gas} value=${netted.value} | ` +
        `savings=${netted.value - old.value}`,
    )
    expect(old.swaps).toBe(2)
    expect(netted.swaps).toBe(1)
    expect(netted.finalIds).toEqual(old.finalIds)
    expect(netted.finalIds).toEqual([remintLoan])
    // The temporary loan is minted and burned within the dispatch — never left behind.
    expect(netted.finalIds).not.toContain(candidate.temporaryLoan.tokenId)
    expect(netted.value).toBeGreaterThan(old.value)
  }, 120_000)

  it('costs more when the reminted remainder is small (accepted always-net tradeoff)', async () => {
    // Shrink almost the whole loan (tiny remint): the two gross swaps barely
    // overlap, so netting saves little swap volume while paying commission on a
    // large temporary loan. This documents the case where always-net loses.
    const smallRemint = 170_974465n
    const smallRemintLoan = loanId(poolId, alignedStrike - 2n * tickSpacing)
    const intent: HedgeIntent = {
      action: 'shrink',
      openTokenId: smallRemintLoan,
      openPositionSize: smallRemint,
      swapAtMint: true,
      closeTokenIds: [oldLoan],
      existingPositionIds: [oldLoan],
      skippedCollidingTokenIds: [],
      currentTick: markTick,
      slippageBps: SLIPPAGE_BPS,
    }
    const built = buildBatchDispatchArgs({
      items: buildHedgeBatchOps(intent, POOL_ADDRESS),
      existingPositionIds: [oldLoan],
      usePremiaAsCollateral: false,
      builderCode: 0n,
    })
    if (!built.args) throw new Error('small-remainder build failed')
    const existingPositions = (
      await getPositions({
        client: sdkClient,
        poolAddress: POOL_ADDRESS,
        owner: owner.address,
        tokenIds: [oldLoan],
      })
    ).positions
    const candidate = buildNettedShrinkDispatch({
      dispatch: built.args,
      existingPositions,
      currentTick: markTick,
      slippageBps: SLIPPAGE_BPS,
    })
    expect(candidate.amountOut).toBe(OLD_LOAN_USDC - smallRemint)

    const old = await runRoute(built.args)
    const netted = await runRoute(candidate.dispatch, [candidate.temporaryLoan.tokenId])
    // eslint-disable-next-line no-console
    console.log(
      `[fork] small-remainder: original value=${old.value} netted value=${netted.value} ` +
        `delta=${netted.value - old.value}`,
    )
    expect(netted.value).toBeLessThan(old.value)
  }, 120_000)
})
