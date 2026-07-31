import {
  type BatchOp,
  buildBatchDispatchArgs,
  panopticPoolV2Abi,
  simulateBatchDispatch,
} from '@panoptic-eng/sdk/v2'
import type { Address, Hex, PublicClient } from 'viem'
import { encodeFunctionData } from 'viem'

import { buildUniqueLoan } from '../hedge/frame'
import { normalizePostDispatchMargin } from '../hedge/marginReserve'
import type { RolesExecutor } from '../safe/rolesExecutor'
import { botLog } from '../utils/log'
import { asSdkClient } from '../utils/sdkClient'
import {
  buildHedgeBatchOps,
  buildHedgeDispatchCalldata,
  buildOffVenueHedgeBatchOps,
  buildOffVenueHedgeDispatchCalldata,
  hedgeTickBand,
} from './dispatchCalldata'
import type {
  CollateralSwapRequest,
  HedgeContext,
  HedgeExecutionResult,
  HedgeExecutor,
  HedgeIntent,
  HedgeSwapRequirement,
} from './types'

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

// Re-exported from the shared dispatch-calldata module (single source of truth,
// also used by the SFPM off-venue coordinator). Kept here for existing importers.
export { slippageBpsToTickDistance } from './dispatchCalldata'

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

  const buildItems = (intent: HedgeIntent): BatchOp[] => buildHedgeBatchOps(intent, poolAddress)
  const buildDispatchData = (intent: HedgeIntent): Hex =>
    buildHedgeDispatchCalldata(intent, { poolAddress, builderCode })
  const buildOffVenueDispatchData = (intent: HedgeIntent): Hex =>
    buildOffVenueHedgeDispatchCalldata(intent, { poolAddress, builderCode })
  const abs = (value: bigint): bigint => (value < 0n ? -value : value)

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

  async function executeDispatch(
    intent: HedgeIntent,
    buildData: (intent: HedgeIntent) => Hex,
    ctx?: HedgeContext,
  ): Promise<HedgeExecutionResult> {
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
      data: buildData(intent),
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
  }

  async function deriveSwapRequirement(intent: HedgeIntent): Promise<HedgeSwapRequirement | null> {
    const simulate = (swapAtMint: boolean) =>
      simulateBatchDispatch({
        client: asSdkClient<typeof simulateBatchDispatch>(publicClient),
        poolAddress,
        account: safeAddress,
        items: swapAtMint
          ? buildHedgeBatchOps({ ...intent, swapAtMint: true }, poolAddress)
          : buildOffVenueHedgeBatchOps(intent, poolAddress),
        existingPositionIds: intent.existingPositionIds,
        usePremiaAsCollateral: false,
        builderCode,
      })
    const [withSwap, withoutSwap] = await Promise.all([simulate(true), simulate(false)])
    if (
      !withSwap.success ||
      !withoutSwap.success ||
      !withSwap.tokenFlow ||
      !withoutSwap.tokenFlow
    ) {
      return null
    }
    const delta0 = withSwap.tokenFlow.delta0 - withoutSwap.tokenFlow.delta0
    const delta1 = withSwap.tokenFlow.delta1 - withoutSwap.tokenFlow.delta1
    if (delta0 === 0n || delta1 === 0n || delta0 < 0n === delta1 < 0n) return null
    const sellTokenType = delta0 < 0n ? 0 : 1
    return {
      sellTokenType,
      amountIn: abs(sellTokenType === 0 ? delta0 : delta1),
      inPoolAmountOut: abs(sellTokenType === 0 ? delta1 : delta0),
    }
  }

  function buildCollateralSwapCall(request: CollateralSwapRequest) {
    if (request.amountIn <= 0n) throw new Error('collateral swap input must be positive')
    const built = buildUniqueLoan(
      request.poolId,
      {
        asset: BigInt(request.sellTokenType),
        tokenType: BigInt(request.sellTokenType),
        strike:
          request.currentTick -
          (request.currentTick % request.tickSpacing) -
          (request.currentTick < 0n && request.currentTick % request.tickSpacing !== 0n
            ? request.tickSpacing
            : 0n),
      },
      request.existingPositionIds,
      request.amountIn,
    )
    const swapBand = hedgeTickBand(true, request.currentTick, request.slippageBps)
    const noSwapBand = hedgeTickBand(false, request.currentTick, request.slippageBps)
    return {
      to: poolAddress,
      value: 0n,
      data: encodeFunctionData({
        abi: panopticPoolV2Abi,
        functionName: 'dispatch',
        args: [
          [built.tokenId, built.tokenId],
          request.existingPositionIds,
          [built.adjustedSize, 0n],
          [
            [Number(noSwapBand.low), Number(noSwapBand.high), 0],
            [Number(swapBand.high), Number(swapBand.low), 0],
          ],
          false,
          builderCode,
        ],
      }),
      operation: 0 as const,
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
    execute(intent: HedgeIntent, ctx?: HedgeContext) {
      return executeDispatch(intent, buildDispatchData, ctx)
    },
    executeOffVenue(intent: HedgeIntent, ctx?: HedgeContext) {
      return executeDispatch(intent, buildOffVenueDispatchData, ctx)
    },
    deriveSwapRequirement,
    async simulateCollateralSwap(request: CollateralSwapRequest) {
      await rolesExecutor.simulate(buildCollateralSwapCall(request))
    },
    async executeCollateralSwap(request: CollateralSwapRequest, ctx?: HedgeContext) {
      const call = buildCollateralSwapCall(request)
      if (dryRun) {
        await rolesExecutor.simulate(call)
        return {
          transactionHash: null,
          receipt: null,
          amountIn: request.amountIn,
          dryRun: true,
        }
      }
      const receipt = await rolesExecutor.send(call, { urgent: ctx?.urgent })
      return {
        transactionHash: receipt.transactionHash,
        receipt,
        amountIn: request.amountIn,
        dryRun: false,
      }
    },
  }
}
