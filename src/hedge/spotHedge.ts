import { toVaultFrameAtSqrtPriceX96 } from './frame'

/**
 * Spot-rebalance sizing for cross-pool hedging. Unlike the loan model, the
 * cross-pool hedge holds no positions — it neutralizes `netDelta` by swapping
 * the CT asset/numeraire composition. `netDelta` is signed, in asset-token
 * smallest units (vault frame):
 *   netDelta > 0  ⇒ portfolio is long the asset  ⇒ SELL asset for numeraire
 *   netDelta < 0  ⇒ portfolio is short the asset ⇒ BUY asset with numeraire
 */
export interface SpotSwapPlan {
  action: 'none' | 'swap'
  sellAssetIndex: 0n | 1n
  buyAssetIndex: 0n | 1n
  /** Exact input amount (smallest units of the sell token). */
  amountIn: bigint
  /** Minimum acceptable output after slippage (smallest units of the buy token). */
  minAmountOut: bigint
  netDelta: bigint
  driftBps: bigint
}

export interface SizeSpotHedgeInput {
  netDelta: bigint
  assetIndex: 0n | 1n
  /** Current price as sqrtPriceX96 (from the price signal). */
  sqrtPriceX96: bigint
  slippageBps: bigint
  deltaThresholdBps: bigint
  /** Option-book size in the vault asset frame (drift denominator). */
  portfolioSize: bigint
}

const abs = (x: bigint): bigint => (x < 0n ? -x : x)

export function sizeSpotHedge(input: SizeSpotHedgeInput): SpotSwapPlan {
  const { netDelta, assetIndex, sqrtPriceX96, slippageBps, deltaThresholdBps, portfolioSize } =
    input
  const numeraireIndex: 0n | 1n = assetIndex === 0n ? 1n : 0n
  // NOTE: unlike the in-pool loan planner (decision.ts), this spot model holds NO
  // hedge positions, so there is no gross hedge book to fall back to when the
  // option book is empty. An empty-option standalone-exposure case therefore stays
  // gated here; unwinding it needs a different basis (collateral notional) and is a
  // separate decision. Kept asymmetric on purpose — not an oversight.
  const driftBps = portfolioSize > 0n ? (abs(netDelta) * 10_000n) / portfolioSize : 0n

  const none: SpotSwapPlan = {
    action: 'none',
    sellAssetIndex: assetIndex,
    buyAssetIndex: numeraireIndex,
    amountIn: 0n,
    minAmountOut: 0n,
    netDelta,
    driftBps,
  }
  if (portfolioSize === 0n || driftBps <= deltaThresholdBps) return none

  const mag = abs(netDelta) // asset-token smallest units
  const numeraireEquiv = toVaultFrameAtSqrtPriceX96(mag, assetIndex, numeraireIndex, sqrtPriceX96)
  const keepBps = 10_000n - slippageBps

  if (netDelta > 0n) {
    // Long → sell `mag` asset for numeraire.
    return {
      action: 'swap',
      sellAssetIndex: assetIndex,
      buyAssetIndex: numeraireIndex,
      amountIn: mag,
      minAmountOut: (numeraireEquiv * keepBps) / 10_000n,
      netDelta,
      driftBps,
    }
  }
  // Short → buy `mag` asset with numeraire.
  return {
    action: 'swap',
    sellAssetIndex: numeraireIndex,
    buyAssetIndex: assetIndex,
    amountIn: numeraireEquiv,
    minAmountOut: (mag * keepBps) / 10_000n,
    netDelta,
    driftBps,
  }
}
