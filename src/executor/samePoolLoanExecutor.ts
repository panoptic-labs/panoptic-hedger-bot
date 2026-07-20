import {
  type BatchOp,
  buildBatchDispatchArgs,
  panopticPoolV2Abi,
  simulateBatchDispatch,
} from '@panoptic-eng/sdk/v2'
import type { Address, Hex, PublicClient } from 'viem'
import { encodeFunctionData } from 'viem'

import { MAX_TICK, MIN_TICK } from '../constants/ticks'
import { normalizePostDispatchMargin } from '../hedge/marginReserve'
import type { RolesExecutor } from '../safe/rolesExecutor'
import { botLog } from '../utils/log'
import { asSdkClient } from '../utils/sdkClient'
import type { HedgeContext, HedgeExecutionResult, HedgeExecutor, HedgeIntent } from './types'

export interface SamePoolLoanExecutorDeps {
  poolAddress: Address
  publicClient: PublicClient
  safeAddress: Address
  rolesExecutor: RolesExecutor
  /** Referral/builder code forwarded to dispatch (0n = none). */
  builderCode?: bigint
  /** When true, simulate via eth_call instead of sending. */
  dryRun: boolean
}

/** Convert price basis points to the smallest conservative Uniswap tick distance. */
export function slippageBpsToTickDistance(slippageBps: bigint): bigint {
  if (slippageBps < 0n || slippageBps > 500n) throw new Error('slippage bps out of bounds')
  if (slippageBps === 0n) return 0n
  let numerator = 1n
  let denominator = 1n
  let ticks = 0n
  while (numerator * 10_000n < denominator * (10_000n + slippageBps)) {
    numerator *= 10_001n
    denominator *= 10_000n
    ticks += 1n
  }
  return ticks
}

/**
 * v1 executor. Builds an atomic PanopticPool.dispatch (mint loan + burn closed
 * hedges) and routes it through the Zodiac Roles modifier as the bot EOA.
 *
 * The dispatch args (op ordering, per-op tick-limit ordering for swapAtMint,
 * burn zero-sizing, finalPositionIdList) come from the SDK `buildBatchDispatchArgs`
 * — we do not hand-roll them. `encodeFunctionData` is only used to turn those
 * SDK-built args into calldata for the Roles wrapper (the SDK `dispatch` sends
 * directly and cannot return calldata for the Roles-routed path).
 */
export function createSamePoolLoanExecutor(deps: SamePoolLoanExecutorDeps): HedgeExecutor {
  const { poolAddress, publicClient, safeAddress, rolesExecutor, dryRun } = deps
  const builderCode = deps.builderCode ?? 0n

  /** Per-op tick band: slippage band around the tick when swapping, else full range. */
  function tickBand(swapAtMint: boolean, currentTick: bigint, slippageBps: bigint) {
    if (!swapAtMint) return { low: BigInt(MIN_TICK), high: BigInt(MAX_TICK) }
    const distance = slippageBpsToTickDistance(slippageBps)
    return { low: currentTick - distance, high: currentTick + distance }
  }

  function buildItems(intent: HedgeIntent): BatchOp[] {
    const { openTokenId, openPositionSize, closeTokenIds } = intent
    const band = tickBand(intent.swapAtMint, intent.currentTick, intent.slippageBps)

    const items: BatchOp[] = []
    // Release margin from replaced loans before opening their consolidated hedge.
    for (const tokenId of closeTokenIds) {
      items.push({
        kind: 'burn',
        poolAddress,
        tokenId,
        tickLimitLow: band.low,
        tickLimitHigh: band.high,
        swapAtMint: intent.swapAtMint,
      })
    }
    if (openTokenId !== null && openPositionSize !== null) {
      items.push({
        kind: 'mint',
        poolAddress,
        tokenId: openTokenId,
        positionSize: openPositionSize,
        tickLimitLow: band.low,
        tickLimitHigh: band.high,
        swapAtMint: intent.swapAtMint,
        spreadLimit: 0n,
      })
    }

    return items
  }

  function buildDispatchData(intent: HedgeIntent): Hex {
    const { existingPositionIds } = intent

    const { args, diagnostics } = buildBatchDispatchArgs({
      items: buildItems(intent),
      existingPositionIds,
      usePremiaAsCollateral: false,
      builderCode,
    })
    if (args === null) {
      throw new Error(`dispatch batch invalid: ${diagnostics.map((d) => d.message).join('; ')}`)
    }

    return encodeFunctionData({
      abi: panopticPoolV2Abi,
      functionName: 'dispatch',
      args: [
        args.positionIdList,
        args.finalPositionIdList,
        args.positionSizes,
        args.tickAndSpreadLimits.map(
          (t) => [Number(t[0]), Number(t[1]), Number(t[2])] as readonly [number, number, number],
        ),
        args.usePremiaAsCollateral,
        args.builderCode,
      ],
    })
  }

  const fmtIds = (ids: bigint[]): string =>
    ids.length === 0 ? '[]' : `[${ids.map((id) => id.toString()).join(', ')}]`

  /**
   * Emit the exact dispatch calldata + pre/post positionIdLists when a preflight
   * fails, so an on-chain `InputListFail` can be diagnosed. The reconstructed
   * `existingPositionIds` drives `finalPositionIdList`; a set mismatch there (or a
   * newly-minted loan that duplicates an existing position) is the usual cause.
   *
   * NOTE: the calldata is printed with `console.log`, NOT `botLog` — the log
   * sanitizer redacts any hex >=130 chars as `0x[redacted-transaction]`, which
   * would blank the very calldata we need. TokenId lists are short and safe for
   * `botLog`.
   */
  function logDispatchDiagnostics(intent: HedgeIntent, reason: string): void {
    try {
      const { args } = buildBatchDispatchArgs({
        items: buildItems(intent),
        existingPositionIds: intent.existingPositionIds,
        usePremiaAsCollateral: false,
        builderCode,
      })
      const duplicate =
        intent.openTokenId !== null && intent.existingPositionIds.includes(intent.openTokenId)
      botLog(`[hedger-bot] dispatch diagnostics (${reason}):`)
      botLog(`  pre-hedge positionIdList   = ${fmtIds(intent.existingPositionIds)}`)
      botLog(
        `  post-hedge finalPositionIdList = ${args ? fmtIds(args.finalPositionIdList) : 'n/a'}`,
      )
      botLog(`  dispatch positionIdList (ops)  = ${args ? fmtIds(args.positionIdList) : 'n/a'}`)
      botLog(
        `  openTokenId=${intent.openTokenId?.toString() ?? 'null'} ` +
          `closeTokenIds=${fmtIds(intent.closeTokenIds)} ` +
          `skippedColliding=${fmtIds(intent.skippedCollidingTokenIds)}` +
          (duplicate ? ' ⚠️ NEW LOAN DUPLICATES AN EXISTING POSITION' : ''),
      )
      // eslint-disable-next-line no-console -- intentional un-sanitized calldata dump for debugging
      console.log(`  dispatch calldata = ${buildDispatchData(intent)}`)
    } catch (error) {
      botLog(`[hedger-bot] dispatch diagnostics unavailable: ${String(error)}`)
    }
  }

  return {
    kind: 'same-pool-loan',
    async previewFinalState(intent: HedgeIntent, blockNumber: bigint) {
      const simulation = await simulateBatchDispatch({
        client: asSdkClient<typeof simulateBatchDispatch>(publicClient),
        poolAddress,
        account: safeAddress,
        items: buildItems(intent),
        existingPositionIds: intent.existingPositionIds,
        usePremiaAsCollateral: false,
        builderCode,
        blockNumber,
      })
      if (!simulation.success) {
        const detail =
          'error' in simulation
            ? simulation.error.message
            : simulation.diagnostics.map((diagnostic) => diagnostic.message).join('; ')
        const reason = detail
          ? `final-state simulation failed: ${detail}`
          : 'final-state simulation failed'
        logDispatchDiagnostics(intent, reason)
        return { success: false, reason }
      }

      const { postCollateral0, postCollateral1, postMarginExcess0, postMarginExcess1 } =
        simulation.data
      const postTick = simulation.tokenFlow?.tickAfter
      if (
        postMarginExcess0 === null ||
        postMarginExcess1 === null ||
        postTick === null ||
        postTick === undefined
      ) {
        return { success: false, reason: 'final-state simulation returned incomplete margin data' }
      }

      return {
        success: true,
        margin: normalizePostDispatchMargin({
          collateral0: postCollateral0,
          collateral1: postCollateral1,
          marginExcess0: postMarginExcess0,
          marginExcess1: postMarginExcess1,
          tick: postTick,
        }),
      }
    },
    async execute(intent: HedgeIntent, ctx?: HedgeContext): Promise<HedgeExecutionResult> {
      const hasMint = intent.openTokenId !== null && intent.openPositionSize !== null
      const noop = intent.action === 'none' || (!hasMint && intent.closeTokenIds.length === 0)
      if (noop) {
        return {
          transactionHash: null,
          receipt: null,
          openedTokenId: null,
          closedTokenIds: [],
          dryRun,
        }
      }

      const call = {
        to: poolAddress,
        value: 0n,
        data: buildDispatchData(intent),
        operation: 0 as const,
      }

      if (dryRun) {
        await rolesExecutor.simulate(call)
        return {
          transactionHash: null,
          receipt: null,
          openedTokenId: intent.openTokenId,
          closedTokenIds: intent.closeTokenIds,
          dryRun: true,
        }
      }

      const receipt = await rolesExecutor.send(call, { urgent: ctx?.urgent })
      return {
        transactionHash: receipt.transactionHash,
        receipt,
        openedTokenId: intent.openTokenId,
        closedTokenIds: intent.closeTokenIds,
        dryRun: false,
      }
    },
  }
}
