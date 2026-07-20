import type { Hex, TransactionReceipt } from 'viem'

import type { MarginSnapshot } from '../hedge/marginReserve'

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
   * ORDERING per token: descending `[currentTick + tickTolerance,
   * currentTick - tickTolerance, 0]` triggers the SFPM swap; ascending
   * full-range limits do not. Price bps are converted to ticks by the executor.
   * See docs/SWAPATMINT_DISCREPANCY.md.
   */
  swapAtMint: boolean
  /** Hedge tokenIds to burn. */
  closeTokenIds: bigint[]
  /** Current open position id list held by the Safe (dispatch requires it). */
  existingPositionIds: bigint[]
  /**
   * Loan tokenIds that `buildUniqueLoan` skipped (already present in
   * `existingPositionIds`) before landing on `openTokenId`. Diagnostic only —
   * non-empty means the target strike/side was already congested with loans.
   */
  skippedCollidingTokenIds: bigint[]
  /** Pool tick used to center mint tick-limits. */
  currentTick: bigint
  /** Slippage tolerance (bps) for the mint tick-limit. */
  slippageBps: bigint
}

export interface HedgeExecutionResult {
  transactionHash: Hex | null
  receipt: TransactionReceipt | null
  openedTokenId: bigint | null
  closedTokenIds: bigint[]
  dryRun: boolean
}

/**
 * Execution context used for urgency-aware transaction fees.
 */
export interface HedgeContext {
  /**
   * True when drift >= URGENT_DRIFT_MULTIPLIER x threshold — threaded down to
   * the send so gasPolicy applies the urgent tip floor (URGENT_PRIORITY_FEE_GWEI).
   */
  urgent?: boolean
}

export type HedgeFinalStatePreview =
  | { success: true; margin: MarginSnapshot }
  | { success: false; reason: string }

export interface HedgeExecutor {
  readonly kind: 'same-pool-loan'
  /** Simulate the exact ordered dispatch and return its final margin state. */
  previewFinalState(intent: HedgeIntent, blockNumber: bigint): Promise<HedgeFinalStatePreview>
  /** Convert an intent to on-chain calls and submit (or simulate when dryRun). */
  execute(intent: HedgeIntent, ctx?: HedgeContext): Promise<HedgeExecutionResult>
}
