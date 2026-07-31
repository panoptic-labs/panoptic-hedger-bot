import type { Address } from 'viem'
import { getAddress } from 'viem'

import type { HedgeIntent } from '../executor/types'

/**
 * Correspondence between the options pool's collateral assets and the v3 swap
 * pool's token0/token1. Built once at startup by matching asset addresses
 * (native ETH ↔ WETH). The two pools can order their tokens differently, so the
 * mapping must go by address, never by index.
 */
export interface SwapPoolMapping {
  /** v3 swap pool token0 / token1 (address order). */
  swapToken0: Address
  swapToken1: Address
  /**
   * For each Panoptic collateral tokenType (0/1), which v3 swap token index it
   * corresponds to. `tokenTypeToSwapIndex[0]` is the v3 index of the asset
   * behind Panoptic tokenType 0.
   */
  tokenTypeToSwapIndex: readonly [0 | 1, 0 | 1]
}

/**
 * Build the {@link SwapPoolMapping} from the options-pool collateral assets and
 * the v3 swap pool's tokens. `nativeAsWeth` matches a native-ETH collateral
 * asset (0x0) to WETH.
 */
export function buildSwapPoolMapping(params: {
  /** Options-pool underlying asset for tokenType 0 / 1 (0x0 for native ETH). */
  optionsAsset0: Address
  optionsAsset1: Address
  swapToken0: Address
  swapToken1: Address
  weth9: Address
}): SwapPoolMapping {
  const { optionsAsset0, optionsAsset1, swapToken0, swapToken1, weth9 } = params
  const NATIVE = '0x0000000000000000000000000000000000000000'
  const normalize = (a: Address): string => (a === NATIVE ? getAddress(weth9) : getAddress(a))

  const swap0 = getAddress(swapToken0)
  const swap1 = getAddress(swapToken1)
  const indexOf = (asset: Address): 0 | 1 => {
    const a = normalize(asset)
    if (a === swap0) return 0
    if (a === swap1) return 1
    throw new Error(`options collateral ${asset} does not match swap pool tokens`)
  }

  return {
    swapToken0: swap0 as Address,
    swapToken1: swap1 as Address,
    tokenTypeToSwapIndex: [indexOf(optionsAsset0), indexOf(optionsAsset1)],
  }
}

export interface SfpmVenueConfig {
  enabled: boolean
}

/**
 * Whether a hedge intent's in-pool `swapAtMint` swap should be *considered* for
 * off-venue routing. Any state-changing action that swaps is eligible — OPEN,
 * GROW, SHRINK, FLIP, CONSOLIDATE, CLOSE — since the coordinator sizes and
 * directs the net swap from the `swapAtMint` true-vs-false collateral delta
 * (robust across burns + mints), not from any single leg. The coordinator makes
 * the final use/skip call (quote + savings threshold + imbalance sanity).
 *
 * Excluded: `none` (nothing to do) and `swapAtMint=false` intents (the
 * state-preserving capacity consolidate does no swap, so there is nothing to
 * route).
 */
export function isSfpmVenueEligible(intent: HedgeIntent, cfg: SfpmVenueConfig): boolean {
  if (!cfg.enabled) return false
  if (!intent.swapAtMint) return false
  if (intent.action === 'none') return false
  const hasMint = intent.openTokenId !== null && intent.openPositionSize !== null
  return hasMint || intent.closeTokenIds.length > 0
}
