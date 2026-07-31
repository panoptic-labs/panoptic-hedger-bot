import { offVenueFinalPositionIds } from '../executor/dispatchCalldata'
import type {
  SfpmSwapExecutionResult,
  SfpmSwapRequest,
  WalletRedepositResult,
} from '../executor/sfpmSwapExecutor'
import type {
  HedgeContext,
  HedgeExecutionResult,
  HedgeExecutor,
  HedgeIntent,
} from '../executor/types'
import type { SafeWalletBalances } from './walletBalances'

/** Minimal shape of the SFPM swap executor this coordinator needs. */
export interface SfpmSwapExecutorLike {
  execute(req: SfpmSwapRequest): Promise<SfpmSwapExecutionResult>
  /** Pre-flight the off-venue MultiSend; throws the underlying reason on failure. */
  simulate(req: SfpmSwapRequest): Promise<void>
  readWalletBalances(): Promise<SafeWalletBalances>
  redepositWalletBalances(): Promise<WalletRedepositResult>
}

export interface ExecuteWithVenueResult {
  /** The hedge dispatch result (tx1). */
  dispatch: HedgeExecutionResult
  /** The off-venue swap result (tx2), or null if it was not run / failed. */
  swap: SfpmSwapExecutionResult | null
  /**
   * True once the delta is fully neutralized — i.e. the dispatch swap ran in-pool
   * (no off-venue split), OR both tx1 and tx2 landed. False when tx1 landed but
   * the off-venue tx2 did not: the book carries an un-neutralized imbalance the
   * next cycle must clear.
   */
  neutralized: boolean
  /** The tx2 error, when the off-venue swap failed after tx1 landed. */
  swapError?: unknown
}

/**
 * Two-transaction off-venue hedge (user-chosen sequencing):
 *   tx1: dispatch the loan with `swapAtMint=false` (no in-pool swap).
 *   tx2: swap the resulting imbalance in the cheaper 5bps pool via the SFPM.
 *
 * Between the two there is a window where the hedge delta is un-neutralized —
 * accepted as the cost of the simpler design. If tx2 fails after tx1 lands, the
 * result is flagged `neutralized: false` so the caller can alert and the next
 * cycle re-hedges the residual.
 *
 * `swapAmount` is the exact imbalance to swap (the borrowed-token delta the
 * `swapAtMint=false` dispatch leaves behind), derived by the caller from a
 * token-flow simulation — NOT the raw position size (a loan's tokenType usually
 * differs from its asset index, so the moved amount is strike-converted).
 */
export async function executeHedgeWithSfpmVenue(params: {
  dispatchExecutor: HedgeExecutor
  sfpmExecutor: SfpmSwapExecutorLike
  intent: HedgeIntent
  ctx?: HedgeContext
  /** Swap direction from the coordinator's net delta: sell the v3 pool's token0? */
  sellToken0: boolean
  swapAmount: bigint
  /** Coordinator's QuoterV2 output — the executor's deposit-floor basis. */
  expectedAmountOut: bigint
  swapPoolTick: number
  /**
   * Durable boundary between tx1 and tx2. The caller confirms the dispatch
   * journal and opens the separate swap journal before this function may send
   * the SFPM transaction.
   */
  beforeDispatch?: (pending: { sellToken0: boolean; amount: bigint }) => void | Promise<void>
  afterDispatch?: (dispatch: HedgeExecutionResult) => void | Promise<void>
}): Promise<ExecuteWithVenueResult> {
  const {
    dispatchExecutor,
    sfpmExecutor,
    intent,
    ctx,
    sellToken0,
    swapAmount,
    expectedAmountOut,
    swapPoolTick,
    beforeDispatch,
    afterDispatch,
  } = params

  await beforeDispatch?.({ sellToken0, amount: swapAmount })

  // tx1: dispatch WITHOUT the in-pool swap. The executor uses the off-venue
  // operation ordering (replacement mint before burns) so the borrowed tokens
  // are available for repayment before tx2 rebalances the net collateral.
  const dispatch = await dispatchExecutor.executeOffVenue(intent, ctx)

  // A dry-run dispatch does not move funds, so there is nothing to rebalance.
  if (dispatch.dryRun) {
    return { dispatch, swap: null, neutralized: true }
  }

  await afterDispatch?.(dispatch)

  // tx2: neutralize the imbalance off-venue.
  try {
    const swap = await sfpmExecutor.execute({
      sellToken0,
      kind: 'exactIn',
      amount: swapAmount,
      expectedAmountOut,
      currentTick: swapPoolTick,
      positionIdList: offVenueFinalPositionIds(intent),
    })
    if (!swap.dryRun && (!swap.receipt || !swap.transactionHash)) {
      throw new Error('live SFPM executor returned without a confirmed transaction receipt')
    }
    if (swap.receipt?.status === 'reverted') {
      throw new Error(`off-venue swap reverted: ${swap.receipt.transactionHash}`)
    }
    return { dispatch, swap, neutralized: true }
  } catch (swapError) {
    return { dispatch, swap: null, neutralized: false, swapError }
  }
}
