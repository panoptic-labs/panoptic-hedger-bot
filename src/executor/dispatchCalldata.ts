import {
  type BatchOp,
  buildBatchDispatchArgs,
  panopticPoolV2Abi,
  slippageBpsToTickDistance,
} from '@panoptic-eng/sdk/v2'
import type { Address, Hex } from 'viem'
import { encodeFunctionData } from 'viem'

import { MAX_TICK, MIN_TICK } from '../constants/ticks'
import type { HedgeIntent } from './types'

// Single source of truth for the bps→tick-distance conversion (0..1000 bound);
// re-exported for existing importers (e.g. samePoolLoanExecutor + its tests).
export { slippageBpsToTickDistance } from '@panoptic-eng/sdk/v2'

/** Per-op tick band: slippage band around the tick when swapping, else full range. */
export function hedgeTickBand(
  swapAtMint: boolean,
  currentTick: bigint,
  slippageBps: bigint,
): { low: bigint; high: bigint } {
  if (!swapAtMint) return { low: BigInt(MIN_TICK), high: BigInt(MAX_TICK) }
  const distance = slippageBpsToTickDistance(slippageBps)
  return { low: currentTick - distance, high: currentTick + distance }
}

/**
 * Build the dispatch BatchOps for a hedge intent: release margin from replaced
 * loans (burns) before opening their consolidated hedge (mint). The per-op
 * tick-limit ordering encodes `swapAtMint` (see HedgeIntent docs).
 */
export function buildHedgeBatchOps(intent: HedgeIntent, poolAddress: Address): BatchOp[] {
  const { openTokenId, openPositionSize, closeTokenIds } = intent
  const band = hedgeTickBand(intent.swapAtMint, intent.currentTick, intent.slippageBps)

  const items: BatchOp[] = []
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

/**
 * Build the no-swap dispatch used before an off-venue rebalance.
 *
 * Mint first so a replacement loan makes its borrowed tokens available before
 * the burns repay the old loans. Burn-first can revert with `NotEnoughTokens`
 * even when the final net change is affordable, because the replacement mint's
 * tokens have not reached collateral yet.
 */
export function buildOffVenueHedgeBatchOps(intent: HedgeIntent, poolAddress: Address): BatchOp[] {
  const items = buildHedgeBatchOps({ ...intent, swapAtMint: false }, poolAddress)
  return [
    ...items.filter((item) => item.kind === 'mint'),
    ...items.filter((item) => item.kind === 'burn'),
  ]
}

/**
 * Position list after the no-swap dispatch lands. The off-venue withdrawal runs
 * in tx2, so its solvency check must use this post-dispatch list.
 */
export function offVenueFinalPositionIds(intent: HedgeIntent): bigint[] {
  const closed = new Set(intent.closeTokenIds)
  const opened = intent.openTokenId === null ? [] : [intent.openTokenId]
  const openedSet = new Set(opened)
  return [
    ...intent.existingPositionIds.filter((id) => !closed.has(id) && !openedSet.has(id)),
    ...opened,
  ]
}

function encodeHedgeDispatchCalldata(
  intent: HedgeIntent,
  deps: { poolAddress: Address; builderCode: bigint },
  items: BatchOp[],
): Hex {
  const { args, diagnostics } = buildBatchDispatchArgs({
    items,
    existingPositionIds: intent.existingPositionIds,
    usePremiaAsCollateral: false,
    builderCode: deps.builderCode,
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

/** Encode `PanopticPool.dispatch` calldata for a hedge intent. */
export function buildHedgeDispatchCalldata(
  intent: HedgeIntent,
  deps: { poolAddress: Address; builderCode: bigint },
): Hex {
  return encodeHedgeDispatchCalldata(intent, deps, buildHedgeBatchOps(intent, deps.poolAddress))
}

/** Encode the mint-first, no-swap dispatch that precedes an off-venue swap. */
export function buildOffVenueHedgeDispatchCalldata(
  intent: HedgeIntent,
  deps: { poolAddress: Address; builderCode: bigint },
): Hex {
  return encodeHedgeDispatchCalldata(
    intent,
    deps,
    buildOffVenueHedgeBatchOps(intent, deps.poolAddress),
  )
}
