/** The classified hedge action for a cycle. `consolidate` is the capacity overlay. */
export type HedgeAction = 'none' | 'open' | 'close_all' | 'grow' | 'shrink' | 'flip' | 'consolidate'

/**
 * The concrete on-chain plan for a cycle: at most one loan mint plus zero or
 * more hedge burns, executed atomically in a single PanopticPool.dispatch.
 * `openTokenId`/`openPositionSize` are resolved (collision-free) loan ids.
 */
export interface HedgeIntent {
  action: HedgeAction
  /** Loan tokenId to open (null when only closing). */
  openTokenId: bigint | null
  /** Adjusted size (positionSize / optionRatio) for the open, or null. */
  openPositionSize: bigint | null
  /**
   * true for state-changing mints/burns; false only for the capacity overlay.
   *
   * ENCODING: `PanopticPool.dispatch` has no swapAtMint parameter — its bool arg
   * is `usePremiaAsCollateral`. The executor must encode this flag as tick-limit
   * ORDERING per token: descending `[currentTick + slippageBps, currentTick -
   * slippageBps, 0]` triggers the SFPM swap; ascending full-range limits do not.
   * See docs/SWAPATMINT_DISCREPANCY.md.
   */
  swapAtMint: boolean
  /** Hedge tokenIds to burn. */
  closeTokenIds: bigint[]
  /** Current open position id list held by the Safe (dispatch requires it). */
  existingPositionIds: bigint[]
  /** Pool tick used to center mint tick-limits. */
  currentTick: bigint
  /** Slippage tolerance (bps) for the mint tick-limit. */
  slippageBps: bigint
}

export interface HedgeExecutionResult {
  txHashes: `0x${string}`[]
  openedTokenId: bigint | null
  closedTokenIds: bigint[]
  dryRun: boolean
  /** Set by cross-pool when it could not cover the delta and fell back to the loan path. */
  fellBackToInPool?: boolean
}

/**
 * Extra context some executors need beyond the loan-shaped HedgeIntent. The
 * cross-pool (spot-rebalance) executor uses it; the in-pool loan executor ignores it.
 */
export interface HedgeContext {
  /** Signed true-total net delta to neutralize (asset-token smallest units). */
  netDelta: bigint
  /** Option-book size in the vault asset frame (drift denominator). */
  portfolioSize: bigint
  /** Current price as sqrtPriceX96 (derived from the price signal). */
  sqrtPriceX96: bigint
  token0Address: `0x${string}`
  token1Address: `0x${string}`
  collateral0Address: `0x${string}`
  collateral1Address: `0x${string}`
}

export interface HedgeExecutor {
  readonly kind: 'same-pool-loan' | 'cross-pool' | 'cowswap'
  /** Convert an intent to on-chain calls and submit (or simulate when dryRun). */
  execute(intent: HedgeIntent, ctx?: HedgeContext): Promise<HedgeExecutionResult>
}
