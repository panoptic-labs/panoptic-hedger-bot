import type { TokenIdLeg } from '@panoptic-eng/sdk/v2'
import {
  createTokenIdBuilder,
  getLegDeltaInVaultFrame,
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

/**
 * Wallet-aware option-book delta (free-collateral term added by the caller).
 *
 * Option legs (width>0): delta is computed in the leg's own `leg.asset` frame then
 * converted to the vault frame.
 *
 * Loan/credit legs (width=0): evaluated DIRECTLY in the vault frame. A width=0 leg
 * on the vault asset is spot the user has "tucked away" — credit = +notional,
 * loan = -notional (in vault-asset units); a width=0 leg on the numeraire has no
 * asset delta (0). `getLegDelta` already returns exactly this when passed the vault
 * `assetIndex`, so it is added directly with no frame conversion. This is NOT the
 * old debt-only convention: it must be counted here because the zapped/committed
 * holdings of a width=0 leg are locked inside the position and therefore absent
 * from the caller's free-collateral term (previously these legs were silently
 * dropped, under-hedging positions that carry ITM-neutralizing credit/loan legs).
 */
export function computePortfolioDelta(
  positions: PositionSnapshot[],
  currentTick: bigint,
  tickSpacing: bigint,
  assetIndex: 0n | 1n,
): bigint {
  return computePortfolioDeltaDetailed(positions, currentTick, tickSpacing, assetIndex).total
}

/** Per-leg delta contribution (vault frame), for diagnostics/tracing. */
export interface LegDeltaBreakdown {
  index: bigint
  width: bigint
  asset: bigint
  tokenType: bigint
  isLong: boolean
  /** 'option' | 'loan' | 'credit' */
  kind: 'option' | 'loan' | 'credit'
  /** Delta contribution in the vault-asset frame (smallest units). */
  delta: bigint
}

/** Per-position delta contribution (vault frame), for diagnostics/tracing. */
export interface PositionDeltaBreakdown {
  tokenId: bigint
  positionSize: bigint
  tickAtMint: bigint
  legs: LegDeltaBreakdown[]
  /** Sum of this position's leg deltas (vault-asset frame). */
  total: bigint
}

export interface PortfolioDeltaBreakdown {
  positions: PositionDeltaBreakdown[]
  /** Sum across all positions (vault-asset frame) — equals computePortfolioDelta. */
  total: bigint
}

/**
 * Same math as {@link computePortfolioDelta} but returns the full per-position,
 * per-leg breakdown so `inspect:hedge` (and tests) can show exactly how the
 * aggregate delta is built. `computePortfolioDelta` delegates here so there is a
 * single source of truth for the aggregation.
 */
export function computePortfolioDeltaDetailed(
  positions: PositionSnapshot[],
  currentTick: bigint,
  tickSpacing: bigint,
  assetIndex: 0n | 1n,
): PortfolioDeltaBreakdown {
  let total = 0n
  const positionBreakdowns: PositionDeltaBreakdown[] = []
  for (const p of positions) {
    const definedRisk = isDefinedRisk(p.legs)
    let posTotal = 0n
    const legBreakdowns: LegDeltaBreakdown[] = []
    for (const leg of p.legs) {
      const delta = getLegDeltaInVaultFrame(
        leg,
        currentTick,
        p.positionSize,
        tickSpacing,
        p.tickAtMint,
        definedRisk,
        assetIndex,
      )
      posTotal += delta
      legBreakdowns.push({
        index: leg.index,
        width: leg.width,
        asset: leg.asset,
        tokenType: leg.tokenType,
        isLong: leg.isLong,
        kind: leg.width === 0n ? (leg.isLong ? 'credit' : 'loan') : 'option',
        delta,
      })
    }
    total += posTotal
    positionBreakdowns.push({
      tokenId: p.tokenId,
      positionSize: p.positionSize,
      tickAtMint: p.tickAtMint,
      legs: legBreakdowns,
      total: posTotal,
    })
  }
  return { positions: positionBreakdowns, total }
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
