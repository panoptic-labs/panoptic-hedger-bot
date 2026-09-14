/**
 * Resolve the netted dispatch to send for an eligible shrink-and-remint.
 *
 * Policy: net every eligible shrink (single-leg, borrowed-token loans on one side
 * of one pool, with a standing remint). The netted dispatch performs one swap of
 * only the principal reduction instead of the gross double-swap; see
 * {@link ./nettedShrink}. There is deliberately NO cost comparison against the
 * in-pool route — the operator accepts that a small-remainder shrink (where the
 * temporary loan's commission can exceed the swap-fee saving) may cost more.
 *
 * Returns the netted dispatch when it is eligible and simulates cleanly, else
 * `null` so the caller falls back to the ordinary in-pool route (ineligible
 * loans, or a netted simulation that reverts after the temp-loan growth attempts).
 *
 * Chain access is injected (`previewDispatchArgs`) so this is unit-testable
 * without a fork.
 */
import { type BatchDispatchArgs, buildBatchDispatchArgs } from '@panoptic-eng/sdk/v2'
import type { Address } from 'viem'

import { buildHedgeBatchOps } from '../executor/dispatchCalldata'
import type { DispatchArgsPreview, HedgeIntent } from '../executor/types'
import {
  type NettedShrinkPosition,
  buildNettedShrinkDispatch,
  evaluateNettedShrinkEligibility,
  nextTemporaryLoanAmount,
} from './nettedShrink'

/** Bounded attempts to grow the temporary loan past a share/asset boundary. */
const MAX_LOAN_GROWTH_ATTEMPTS = 8

export interface NettedShrinkResolverDeps {
  poolAddress: Address
  builderCode: bigint
  /**
   * Simulate a pre-built dispatch at the planning block (existing position list
   * bound by the caller), returning post-dispatch state, or a failure.
   */
  previewDispatchArgs: (dispatch: BatchDispatchArgs) => Promise<DispatchArgsPreview>
}

/**
 * @returns The netted dispatch to send, or `null` when the intent is not an
 * eligible netted shrink, the baseline dispatch cannot be built, or the netted
 * candidate still reverts after the temporary-loan growth attempts (the caller
 * then uses the ordinary in-pool route).
 */
export async function resolveNettedShrinkDispatch(
  intent: HedgeIntent,
  existingPositions: NettedShrinkPosition[],
  currentTick: bigint,
  deps: NettedShrinkResolverDeps,
): Promise<BatchDispatchArgs | null> {
  // Build the ordinary in-pool dispatch — the base the netted candidate wraps.
  const built = buildBatchDispatchArgs({
    items: buildHedgeBatchOps(intent, deps.poolAddress),
    existingPositionIds: intent.existingPositionIds,
    usePremiaAsCollateral: false,
    builderCode: deps.builderCode,
  })
  if (built.args === null) return null
  const original = built.args

  if (!evaluateNettedShrinkEligibility({ dispatch: original, existingPositions }).eligible) {
    return null
  }

  // Build and simulate the netted candidate, growing the temporary loan on a
  // share-boundary revert (trackers compare shares; NotEnoughTokens reports
  // assets, so the exact principal can revert by one share). `DispatchArgsPreview`
  // discards the structured shortfall, so residual-based sizing is unavailable by
  // construction — we grow purely geometrically (~5% steps).
  const buildNetted = (loanAmount?: bigint) =>
    buildNettedShrinkDispatch({
      dispatch: original,
      existingPositions,
      currentTick,
      slippageBps: intent.slippageBps,
      loanAmount,
    })
  let candidate = buildNetted()
  let preview = await deps.previewDispatchArgs(candidate.dispatch)
  let loanAmount = candidate.temporaryLoan.amount
  for (let attempt = 1; !preview.success && attempt < MAX_LOAN_GROWTH_ATTEMPTS; attempt += 1) {
    // Only a token shortfall is fixable by growing the loan. `retryable` is a
    // typed classification set by the executor (via getNotEnoughTokensError); any
    // other revert (PriceBoundFail, RPC error, ineligible pool state) is
    // permanent, so stop immediately and fall back rather than burn 8 sequential
    // simulations delaying the hedge.
    if (!preview.retryable) break
    loanAmount = nextTemporaryLoanAmount(loanAmount, 0n)
    candidate = buildNetted(loanAmount)
    preview = await deps.previewDispatchArgs(candidate.dispatch)
  }

  return preview.success ? candidate.dispatch : null
}
