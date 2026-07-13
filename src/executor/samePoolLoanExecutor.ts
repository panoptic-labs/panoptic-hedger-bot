import { panopticPoolV2Abi } from '@panoptic-eng/sdk/v2'
import { type BatchOp, buildBatchDispatchArgs } from '@panoptic-eng/sdk/v2'
import type { Address, Hex } from 'viem'
import { encodeFunctionData } from 'viem'

import { MAX_TICK, MIN_TICK } from '../constants/ticks'
import type { RolesExecutor } from '../safe/rolesExecutor'
import type { HedgeExecutionResult, HedgeExecutor, HedgeIntent } from './types'

export interface SamePoolLoanExecutorDeps {
  poolAddress: Address
  rolesExecutor: RolesExecutor
  /** Referral/builder code forwarded to dispatch (0n = none). */
  builderCode?: bigint
  /** When true, simulate via eth_call instead of sending. */
  dryRun: boolean
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
  const { poolAddress, rolesExecutor, dryRun } = deps
  const builderCode = deps.builderCode ?? 0n

  /** Per-op tick band: slippage band around the tick when swapping, else full range. */
  function tickBand(swapAtMint: boolean, currentTick: bigint, slippageBps: bigint) {
    if (!swapAtMint) return { low: BigInt(MIN_TICK), high: BigInt(MAX_TICK) }
    return { low: currentTick - slippageBps, high: currentTick + slippageBps }
  }

  function buildDispatchData(intent: HedgeIntent): Hex {
    const { openTokenId, openPositionSize, closeTokenIds, existingPositionIds } = intent
    const band = tickBand(intent.swapAtMint, intent.currentTick, intent.slippageBps)

    const items: BatchOp[] = []
    // Mints precede burns.
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

    const { args, diagnostics } = buildBatchDispatchArgs({
      items,
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

  return {
    kind: 'same-pool-loan',
    async execute(intent: HedgeIntent): Promise<HedgeExecutionResult> {
      const hasMint = intent.openTokenId !== null && intent.openPositionSize !== null
      const noop = intent.action === 'none' || (!hasMint && intent.closeTokenIds.length === 0)
      if (noop) {
        return { txHashes: [], openedTokenId: null, closedTokenIds: [], dryRun }
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
          txHashes: [],
          openedTokenId: intent.openTokenId,
          closedTokenIds: intent.closeTokenIds,
          dryRun: true,
        }
      }

      const hash = await rolesExecutor.send(call)
      return {
        txHashes: [hash],
        openedTokenId: intent.openTokenId,
        closedTokenIds: intent.closeTokenIds,
        dryRun: false,
      }
    },
  }
}
