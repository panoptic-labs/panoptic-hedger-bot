import type { TokenIdLeg } from '@panoptic-eng/sdk/v2'
import {
  createTokenIdBuilder,
  getLegDelta,
  isDefinedRisk,
  tickToSqrtPriceX96,
} from '@panoptic-eng/sdk/v2'

/** 2^192, used for sqrtPriceX96^2 scaling in frame conversions. */
const Q192 = 1n << 192n

/** A minimal snapshot of an open position needed for delta/size math. */
export interface PositionSnapshot {
  tokenId: bigint
  legs: TokenIdLeg[]
  positionSize: bigint
  tickAtMint: bigint
}

/**
 * Convert a value expressed in `fromAsset`'s frame into `vaultAssetIndex`'s
 * frame at a given sqrtPriceX96. Ported verbatim from vault-managers so the
 * hedge math matches the proven implementation.
 */
export function toVaultFrameAtSqrtPriceX96(
  value: bigint,
  fromAsset: bigint,
  vaultAssetIndex: 0n | 1n,
  sqrtPriceX96: bigint,
  flipSignOnAssetInversion = false,
): bigint {
  if (fromAsset === vaultAssetIndex) return value
  const converted =
    vaultAssetIndex === 0n
      ? (value * Q192) / (sqrtPriceX96 * sqrtPriceX96) // token1 -> token0
      : (value * sqrtPriceX96 * sqrtPriceX96) / Q192 // token0 -> token1
  return flipSignOnAssetInversion ? -converted : converted
}

export function toVaultFrameAtTick(
  delta: bigint,
  fromAsset: bigint,
  vaultAssetIndex: 0n | 1n,
  currentTick: bigint,
  flipSignOnAssetInversion = false,
): bigint {
  if (fromAsset === vaultAssetIndex) return delta
  const sqrtPriceX96 = tickToSqrtPriceX96(currentTick)
  return toVaultFrameAtSqrtPriceX96(
    delta,
    fromAsset,
    vaultAssetIndex,
    sqrtPriceX96,
    flipSignOnAssetInversion,
  )
}

/**
 * Wallet-aware option-book delta (collateral term added by the caller). For each
 * leg, computes delta in its own `leg.asset` frame then converts to the vault
 * frame. For loans (width=0), getLegDelta returns debt-only delta.
 */
export function computePortfolioDelta(
  positions: PositionSnapshot[],
  currentTick: bigint,
  tickSpacing: bigint,
  assetIndex: 0n | 1n,
): bigint {
  let delta = 0n
  for (const p of positions) {
    const definedRisk = isDefinedRisk(p.legs)
    for (const leg of p.legs) {
      const legDelta = getLegDelta(
        leg,
        currentTick,
        p.positionSize,
        tickSpacing,
        p.tickAtMint,
        definedRisk,
      )
      delta += toVaultFrameAtTick(legDelta, leg.asset, assetIndex, currentTick, leg.width > 0n)
    }
  }
  return delta
}

/** Portfolio size in the vault asset frame, restricted to non-loan (option) legs. */
export function computePortfolioSizeInVaultAsset(
  positions: PositionSnapshot[],
  assetIndex: 0n | 1n,
): bigint {
  let portfolioSize = 0n
  for (const position of positions) {
    for (const leg of position.legs) {
      if (leg.width === 0n) continue
      const legSize = position.positionSize * leg.optionRatio
      const strikeSqrtPriceX96 = tickToSqrtPriceX96(leg.strike)
      portfolioSize += toVaultFrameAtSqrtPriceX96(
        legSize,
        leg.asset,
        assetIndex,
        strikeSqrtPriceX96,
      )
    }
  }
  return portfolioSize
}

/** True when every leg is a loan/credit (width=0) — used to classify hedge positions. */
export function isLoanPosition(legs: Array<{ width: bigint }>): boolean {
  return legs.length > 0 && legs.every((leg) => leg.width === 0n)
}

/**
 * Build a unique loan tokenId that does not collide with existing open positions,
 * walking optionRatio 1..127. Returns the tokenId and the size adjusted for the
 * chosen ratio (size / optionRatio). Ported from vault-managers.
 */
export function buildUniqueLoan(
  poolId: bigint,
  leg: { asset: bigint; tokenType: bigint; strike: bigint },
  existingIds: bigint[],
  positionSize: bigint,
): { tokenId: bigint; adjustedSize: bigint; skippedCollidingTokenIds: bigint[] } {
  const skippedCollidingTokenIds: bigint[] = []
  for (let ratio = 1n; ratio <= 127n; ratio++) {
    const tokenId = createTokenIdBuilder(poolId)
      .addLoan({
        asset: leg.asset,
        tokenType: leg.tokenType,
        strike: leg.strike,
        optionRatio: ratio,
      })
      .build()
    if (existingIds.includes(tokenId)) {
      skippedCollidingTokenIds.push(tokenId)
      continue
    }
    return { tokenId, adjustedSize: positionSize / ratio, skippedCollidingTokenIds }
  }
  throw new Error('Could not build a unique loan tokenId — all optionRatios 1-127 are in use')
}
