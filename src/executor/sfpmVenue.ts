/**
 * Venue-selection policy for the off-venue SFPM swap.
 *
 * The bot routes the hedge-netting swap through the cheaper 5bps pool (SFPM)
 * only when its quoted output beats the in-pool (30bps `swapAtMint`) path by at
 * least `minSavingsBps`. Both quotes must be for the SAME input amount and
 * direction so the comparison is apples-to-apples.
 */

/**
 * Saving of the SFPM venue over the in-pool venue, in bps of the in-pool output.
 * Positive means the SFPM venue delivers more output. Returns 0 when the in-pool
 * reference is non-positive (no meaningful comparison).
 */
export function sfpmVenueSavingsBps(inPoolAmountOut: bigint, sfpmAmountOut: bigint): bigint {
  if (inPoolAmountOut <= 0n) return 0n
  return ((sfpmAmountOut - inPoolAmountOut) * 10_000n) / inPoolAmountOut
}

/** True when the SFPM venue's saving clears the configured threshold. */
export function shouldUseSfpmVenue(params: {
  inPoolAmountOut: bigint
  sfpmAmountOut: bigint
  minSavingsBps: bigint
}): boolean {
  return sfpmVenueSavingsBps(params.inPoolAmountOut, params.sfpmAmountOut) >= params.minSavingsBps
}
