import type { BatchDispatchArgs } from '@panoptic-eng/sdk/v2'
import type { Hex, TransactionReceipt } from 'viem'

import type { MarginSnapshot } from '../hedge/marginReserve'

/**
 * The classified hedge action for a cycle. `consolidate` is the capacity
 * overlay. `deleverage_loans` / `deleverage_options` are the emergency
 * force-close stages (see hedge/deleverage.ts) — burn-only, never mint.
 */
export type HedgeAction =
  | 'none'
  | 'open'
  | 'close_all'
  | 'grow'
  | 'shrink'
  | 'flip'
  | 'consolidate'
  | 'deleverage_loans'
  | 'deleverage_options'

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

/** The swap embedded in a state-changing hedge dispatch. */
export interface HedgeSwapRequirement {
  /** Options-pool collateral token index sold by the swap. */
  sellTokenType: 0 | 1
  /** Exact input in the sold collateral token's smallest units. */
  amountIn: bigint
  /** Output produced by the ordinary in-pool hedge simulation. */
  inPoolAmountOut: bigint
}

/** Standalone collateral swap which leaves no loan position open. */
export type CollateralSwapRequest = {
  existingPositionIds: bigint[]
  poolId: bigint
  tickSpacing: bigint
  currentTick: bigint
  slippageBps: bigint
} & (
  | { kind: 'exactIn'; tokenType: 0 | 1; amountIn: bigint }
  | {
      kind: 'exactOut'
      /** Token index received by the swap. */
      tokenType: 0 | 1
      amountOut: bigint
      /** Simulated input required for this exact output, when already quoted by the caller. */
      amountIn?: bigint
    }
)

export interface CollateralSwapQuote {
  amountIn: bigint
  amountOut: bigint
}

export interface CollateralSwapResult {
  transactionHash: Hex | null
  receipt: TransactionReceipt | null
  /** Exact input spent, including the simulated/caller-provided input for exact-out swaps. */
  amountIn: bigint
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

/**
 * Preview of a pre-built dispatch (e.g. the netted-shrink candidate) simulated
 * with `simulateDispatch`. On failure, `retryable` is set by the executor from a
 * typed classification of the revert (a collateral token shortfall, fixable by a
 * larger temporary loan) — the caller must not re-parse `reason` to decide.
 */
export type DispatchArgsPreview =
  | { success: true; margin: MarginSnapshot }
  | { success: false; reason: string; retryable: boolean }

export interface HedgeExecutor {
  readonly kind: 'same-pool-loan'
  /** Simulate the exact ordered dispatch and return its final margin state. */
  previewFinalState(intent: HedgeIntent, blockNumber: bigint): Promise<HedgeFinalStatePreview>
  /**
   * Simulate a pre-built dispatch (e.g. the netted-shrink candidate) with
   * `simulateDispatch` — the batch-validator path cannot preview a dispatch whose
   * temporary loan reuses one tokenId. Returns margin + post-dispatch collateral.
   * Optional (like the other advanced methods) for test/dummy executors.
   */
  previewDispatchArgs?(
    dispatch: BatchDispatchArgs,
    existingPositionIds: bigint[],
    blockNumber: bigint,
  ): Promise<DispatchArgsPreview>
  /**
   * Submit (or simulate when dryRun) a pre-built dispatch. Used to send the
   * chosen route's exact dispatch — the same args that were previewed.
   * Optional (like the other advanced methods) for test/dummy executors.
   */
  executeDispatchArgs?(
    dispatch: BatchDispatchArgs,
    result: { openedTokenId: bigint | null; closedTokenIds: bigint[] },
    ctx?: HedgeContext,
  ): Promise<HedgeExecutionResult>
  /** Convert an intent to on-chain calls and submit (or simulate when dryRun). */
  execute(intent: HedgeIntent, ctx?: HedgeContext): Promise<HedgeExecutionResult>
  /**
   * Execute the no-swap dispatch half of an off-venue hedge. Its operation
   * ordering may differ from the ordinary in-pool dispatch.
   */
  executeOffVenue(intent: HedgeIntent, ctx?: HedgeContext): Promise<HedgeExecutionResult>
  /**
   * Resolve the exact swap performed by swapAtMint for balance-first routing.
   * Optional for test/dummy executors which do not support standalone swaps.
   */
  deriveSwapRequirement?(intent: HedgeIntent): Promise<HedgeSwapRequirement | null>
  /** Quote an exact-input or exact-output temporary-credit swap with no open position. */
  simulateCollateralSwap?(request: CollateralSwapRequest): Promise<CollateralSwapQuote>
  /** Execute an exact-input or exact-output temporary-credit swap with no open position. */
  executeCollateralSwap?(
    request: CollateralSwapRequest,
    ctx?: HedgeContext,
  ): Promise<CollateralSwapResult>
}
