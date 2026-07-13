import {
  buildV3SwapExecuteCalldata,
  buildV4SwapExecuteCalldata,
  quoteV3ExactIn,
  quoteV4ExactInByPoolKey,
} from '@panoptic-eng/sdk/uniswap'
import { collateralTrackerV2Abi, getMaxWithdrawable } from '@panoptic-eng/sdk/v2'
import type { Address, Hex, PublicClient } from 'viem'
import { encodeFunctionData, zeroAddress } from 'viem'

import type { HedgePoolSpec } from '../config'
import { sizeSpotHedge } from '../hedge/spotHedge'
import type { RolesExecutor } from '../safe/rolesExecutor'
import { asSdkClient } from '../utils/sdkClient'
import { type MultiSendCall, encodeMultiSend } from './multiSend'
import type { HedgeContext, HedgeExecutionResult, HedgeExecutor, HedgeIntent } from './types'

export interface CrossPoolExecutorDeps {
  publicClient: PublicClient
  chainId: bigint
  safeAddress: Address
  rolesExecutor: RolesExecutor
  /** Fallback loan executor used when withdrawable margin can't cover the swap. */
  fallback: HedgeExecutor
  universalRouter: Address
  multiSend: Address
  /** Whitelisted hedge pools (v3/v4) on the vault's token pair; best-quoted per cycle. */
  hedgePools: HedgePoolSpec[]
  assetIndex: 0n | 1n
  slippageBps: bigint
  dryRun: boolean
  nowSeconds?: () => bigint
}

const DEADLINE_SECONDS = 600n

/** The best-quoted whitelisted pool for a given swap, with its swap calldata. */
interface BestSwap {
  data: Hex
  value: bigint
  amountOut: bigint
  minAmountOut: bigint
}

/**
 * Feature 3 — cross-pool spot-rebalance hedge. Neutralizes net delta by
 * atomically withdrawing from the CollateralTracker, swapping asset↔numeraire on
 * a DIFFERENT Uniswap v4 pool, and re-depositing — all in one Safe MultiSend
 * batch routed through the Roles modifier (operation=DelegateCall). When the
 * withdrawable margin can't cover the swap, it falls back wholesale to the
 * in-pool loan executor.
 *
 * ⚠️  The on-chain batch composition (CT withdraw/deposit + router swap via
 * MultiSend) is ops-level and must be fork-validated; only the pure sizing
 * (sizeSpotHedge) and MultiSend encoding are unit-tested. Requires one-time
 * Safe→Permit2→router approvals AND a Safe→CollateralTracker ERC-20 approval for
 * both pool tokens (the re-deposit leg pulls the bought token from the Safe;
 * without it every cycle reverts on deposit). See runbook.md.
 */
export function createCrossPoolExecutor(deps: CrossPoolExecutorDeps): HedgeExecutor {
  const {
    publicClient,
    chainId,
    safeAddress,
    rolesExecutor,
    fallback,
    assetIndex,
    slippageBps,
    dryRun,
  } = deps
  const nowSeconds = deps.nowSeconds ?? (() => BigInt(Math.floor(Date.now() / 1000)))

  function tokenAddress(index: 0n | 1n, ctx: HedgeContext): Address {
    return index === 0n ? ctx.token0Address : ctx.token1Address
  }
  function collateralAddress(index: 0n | 1n, ctx: HedgeContext): Address {
    return index === 0n ? ctx.collateral0Address : ctx.collateral1Address
  }

  /**
   * Quote the sell→buy swap across every whitelisted pool, then build the swap
   * calldata for the pool with the highest output. Pools that revert on quote
   * (missing / no liquidity) are skipped. Returns null if none can quote.
   */
  async function selectBestSwap(args: {
    currency0: Address
    currency1: Address
    sellToken: Address
    buyToken: Address
    amountIn: bigint
    zeroForOne: boolean
  }): Promise<BestSwap | null> {
    const { currency0, currency1, sellToken, buyToken, amountIn, zeroForOne } = args
    const deadline = nowSeconds() + DEADLINE_SECONDS
    const quotes = await Promise.all(
      deps.hedgePools.map(async (pool): Promise<BestSwap | null> => {
        try {
          if (pool.version === 'v4') {
            const poolKey = {
              currency0,
              currency1,
              fee: BigInt(pool.fee),
              tickSpacing: BigInt(pool.tickSpacing),
              hooks: (pool.hooks ?? zeroAddress) as Address,
            }
            const q = await quoteV4ExactInByPoolKey({
              client: asSdkClient<typeof quoteV4ExactInByPoolKey>(publicClient),
              chainId,
              poolKey,
              zeroForOne,
              amountIn,
              slippageBps,
            })
            if (!q) return null
            const { data, value } = buildV4SwapExecuteCalldata({
              poolKey,
              zeroForOne,
              amountIn,
              amountOutMinimum: q.amountOutMinimum,
              tokenIn: sellToken,
              tokenOut: buyToken,
              deadline,
              recipient: safeAddress,
            })
            return { data, value, amountOut: q.amountOut, minAmountOut: q.amountOutMinimum }
          }
          const q = await quoteV3ExactIn({
            client: asSdkClient<typeof quoteV3ExactIn>(publicClient),
            chainId,
            tokenIn: sellToken,
            tokenOut: buyToken,
            fee: BigInt(pool.fee),
            amountIn,
            slippageBps,
          })
          if (!q) return null
          const { data, value } = buildV3SwapExecuteCalldata({
            tokenIn: sellToken,
            tokenOut: buyToken,
            fee: BigInt(pool.fee),
            amountIn,
            amountOutMinimum: q.amountOutMinimum,
            deadline,
          })
          return { data, value, amountOut: q.amountOut, minAmountOut: q.amountOutMinimum }
        } catch {
          // Isolate per-pool RPC/quote failures so one bad pool doesn't abort
          // the whole hedge cycle — treat it as "no quote" and rank the rest.
          return null
        }
      }),
    )
    return quotes
      .filter((q): q is BestSwap => q !== null)
      .reduce<BestSwap | null>(
        (best, q) => (best === null || q.amountOut > best.amountOut ? q : best),
        null,
      )
  }

  return {
    kind: 'cross-pool',
    async execute(intent: HedgeIntent, ctx?: HedgeContext): Promise<HedgeExecutionResult> {
      if (!ctx) throw new Error('cross-pool executor requires a HedgeContext')

      const plan = sizeSpotHedge({
        netDelta: ctx.netDelta,
        assetIndex,
        sqrtPriceX96: ctx.sqrtPriceX96,
        slippageBps,
        deltaThresholdBps: 0n, // already gated by the bot before calling
        portfolioSize: ctx.portfolioSize,
      })
      if (plan.action === 'none') {
        return { txHashes: [], openedTokenId: null, closedTokenIds: [], dryRun }
      }

      const sellCollateral = collateralAddress(plan.sellAssetIndex, ctx)
      const { maxWithdrawable } = await getMaxWithdrawable({
        client: asSdkClient<typeof getMaxWithdrawable>(publicClient),
        collateralTrackerAddress: sellCollateral,
        account: safeAddress,
        positionIdList: intent.existingPositionIds,
        // Bound the solvency binary search at amountIn — a sufficiency probe:
        // maxWithdrawable == amountIn ⇒ enough free margin; < amountIn ⇒ fall back.
        totalAssets: plan.amountIn,
      })

      // Not enough free margin to source the swap → hedge via the in-pool loan instead.
      if (maxWithdrawable < plan.amountIn) {
        const res = await fallback.execute(intent)
        return { ...res, fellBackToInPool: true }
      }

      const sellToken = tokenAddress(plan.sellAssetIndex, ctx)
      const buyToken = tokenAddress(plan.buyAssetIndex, ctx)
      const buyCollateral = collateralAddress(plan.buyAssetIndex, ctx)

      // Best-quote the swap across the whitelisted pools (v3 + v4). If none can
      // quote (all reverted / no liquidity), fall back to the in-pool loan.
      const best = await selectBestSwap({
        currency0: ctx.token0Address,
        currency1: ctx.token1Address,
        sellToken,
        buyToken,
        amountIn: plan.amountIn,
        zeroForOne: plan.sellAssetIndex === 0n,
      })
      if (best === null) {
        const res = await fallback.execute(intent)
        return { ...res, fellBackToInPool: true }
      }

      // 1. Withdraw the sell token from its CollateralTracker to the Safe.
      const withdrawData = encodeFunctionData({
        abi: collateralTrackerV2Abi,
        functionName: 'withdraw',
        args: [plan.amountIn, safeAddress, safeAddress],
      })
      // 2. Swap sellToken → buyToken on the best-quoted whitelisted pool.
      // 3. Re-deposit the guaranteed minimum output into its CollateralTracker
      //    (positive slippage leaves negligible dust in the Safe; swept later).
      const depositData = encodeFunctionData({
        abi: collateralTrackerV2Abi,
        functionName: 'deposit',
        args: [best.minAmountOut, safeAddress],
      })

      const batch: MultiSendCall[] = [
        { to: sellCollateral, value: 0n, data: withdrawData },
        { to: deps.universalRouter, value: best.value, data: best.data },
        { to: buyCollateral, value: 0n, data: depositData },
      ]
      const call = {
        to: deps.multiSend,
        value: 0n,
        data: encodeMultiSend(batch),
        operation: 1 as const, // DelegateCall to MultiSend
      }

      if (dryRun) {
        await rolesExecutor.simulate(call)
        return { txHashes: [], openedTokenId: null, closedTokenIds: [], dryRun: true }
      }
      const hash: Hex = await rolesExecutor.send(call)
      return { txHashes: [hash], openedTokenId: null, closedTokenIds: [], dryRun: false }
    },
  }
}
