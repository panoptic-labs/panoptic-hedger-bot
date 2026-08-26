import { getLpGreeks } from '@panoptic-eng/sdk/uniswap'
import { tickToSqrtPriceX96, toVaultFrameAtTick } from '@panoptic-eng/sdk/v2'

import type { HedgeAction, HedgeIntent } from '../executor/types'
import {
  type PortfolioDeltaBreakdown,
  type PositionSnapshot,
  buildUniqueLoan,
  computePortfolioDeltaDetailed,
  computePortfolioSizeInVaultAsset,
  toVaultFrameAtSqrtPriceX96,
} from './frame'
import type { LpPositionForHedge } from './lpPositions'
import type { HedgeSnapshot } from './snapshot'
import { type SafeWalletBalances, EMPTY_SAFE_WALLET_BALANCES } from './walletBalances'

/** A hedge loan position reduced to the fields the planner needs. `size` is a positive magnitude in vault-asset units. */
export interface HedgeItem {
  tokenId: bigint
  /** Loan tokenType: === assetIndex means a short hedge (borrows asset); else long. */
  tokenType: bigint
  size: bigint
}

export interface PlanHedgeConfig {
  assetIndex: 0n | 1n
  deltaThresholdBps: bigint
  timedHedgeMinDriftBps?: bigint
  timedHedgeDue?: boolean
  // Signed target net delta the bot hedges toward, as bps of portfolio size
  // (0 = neutral). The book is driven to `netDelta === targetDelta`, not 0.
  deltaOffsetBps: bigint
  absoluteMaxHedgeCount: number
}

export interface PlannedMint {
  tokenType: bigint
  size: bigint
}

export interface PlanHedgeResult {
  action: HedgeAction
  mints: PlannedMint[]
  burns: bigint[]
  swapAtMint: boolean
  H: bigint
  Hstar: bigint
  driftBps: bigint
  triggers: { drift: boolean; timedDrift: boolean; overCap: boolean }
}

export interface HedgeDrift {
  H: bigint
  Hstar: bigint
  driftBps: bigint
}

const abs = (x: bigint): bigint => (x < 0n ? -x : x)
const sameSign = (a: bigint, b: bigint): boolean => (a > 0n && b > 0n) || (a < 0n && b < 0n)

/** The common drift calculation used by both full planning and cached price monitoring. */
export function computeHedgeDrift(
  netDelta: bigint,
  H_short: bigint,
  H_long: bigint,
  portfolioSize: bigint,
  deltaOffsetBps: bigint,
): HedgeDrift {
  const H = H_long - H_short
  const hedgeGross = H_short + H_long
  const sizeBasis = portfolioSize > 0n ? portfolioSize : hedgeGross
  const targetDelta = (sizeBasis * deltaOffsetBps) / 10_000n
  const effectiveDelta = netDelta - targetDelta
  return {
    H,
    Hstar: H - effectiveDelta,
    driftBps: sizeBasis > 0n ? (abs(effectiveDelta) * 10_000n) / sizeBasis : 0n,
  }
}

/** tokenType for a hedge of the given direction. Positive delta ⇒ long ⇒ borrow numeraire. */
function tokenTypeForDirection(positiveDelta: boolean, assetIndex: 0n | 1n): bigint {
  const numeraire = assetIndex === 0n ? 1n : 0n
  return positiveDelta ? numeraire : assetIndex
}

/**
 * Pure hedge planner implementing the 5-case tree (OPEN / CLOSE_ALL / GROW /
 * SHRINK / FLIP) plus the state-preserving capacity overlay, per
 * apps/vault-managers/.../EFFICIENT_HEDGING_ALGORITHM.md.
 *
 * `netDelta` is the true total (options + hedges + collateral). H is the hedge
 * book's current signed contribution; H* = H − netDelta is its target.
 */
export function planHedge(
  netDelta: bigint,
  H_short: bigint,
  H_long: bigint,
  hedges: HedgeItem[],
  portfolioSize: bigint,
  cfg: PlanHedgeConfig,
): PlanHedgeResult {
  const { H, Hstar, driftBps } = computeHedgeDrift(
    netDelta,
    H_short,
    H_long,
    portfolioSize,
    cfg.deltaOffsetBps,
  )
  // Drift is measured against the option book normally; when all options are
  // closed but a hedge loan remains, fall back to the gross hedge book so a
  // standalone hedge still gets unwound toward H* instead of being stranded
  // with no trigger able to fire.
  const hedgeGross = H_short + H_long
  const sizeBasis = portfolioSize > 0n ? portfolioSize : hedgeGross
  // The bias shifts the target delta the book is driven to. `effectiveDelta` is
  // the delta we actually neutralize; with deltaOffsetBps=0 it equals netDelta,
  // so H* and drift reduce to the delta-neutral case unchanged.
  const drift = driftBps > cfg.deltaThresholdBps
  const overCap = hedges.length > cfg.absoluteMaxHedgeCount
  // A sign change through delta zero is NOT an independent trigger: it must not
  // by itself provoke a delta-changing flip while drift stays below the
  // applicable threshold. The flip *action* still fires once an ordinary
  // trigger (hard drift, timed drift, or capacity) permits planning.
  // Existing triggers own precedence. In particular, a capacity-only
  // consolidation must remain state-preserving and leave a due cadence latched
  // for the next poll.
  const timedDrift =
    !drift &&
    !overCap &&
    cfg.timedHedgeDue === true &&
    cfg.timedHedgeMinDriftBps !== undefined &&
    driftBps > cfg.timedHedgeMinDriftBps
  const triggers = { drift, timedDrift, overCap }
  const deltaDrift = drift || timedDrift

  const none = (action: HedgeAction = 'none'): PlanHedgeResult => ({
    action,
    mints: [],
    burns: [],
    swapAtMint: true,
    H,
    Hstar,
    driftBps,
    triggers,
  })

  if (sizeBasis === 0n) return none()
  if (!(deltaDrift || overCap)) return none()

  const consolidate = (): PlanHedgeResult => {
    // Capacity overlay: collapse all same-side hedges into one WITHOUT changing
    // wallet/net delta (swapAtMint=false, size = |H|).
    const positive = H > 0n
    return {
      action: 'consolidate',
      mints:
        abs(H) > 0n
          ? [{ tokenType: tokenTypeForDirection(positive, cfg.assetIndex), size: abs(H) }]
          : [],
      burns: hedges.map((h) => h.tokenId),
      swapAtMint: false,
      H,
      Hstar,
      driftBps,
      triggers,
    }
  }

  const growConsolidate = (): PlanHedgeResult => {
    // GROW that would breach the cap: close all + open one hedge sized to the
    // full target |H*| on the target side. This IS state-changing (delta moves
    // from H to H*), so swapAtMint=true.
    return {
      action: 'consolidate',
      mints:
        abs(Hstar) > 0n
          ? [{ tokenType: tokenTypeForDirection(Hstar > 0n, cfg.assetIndex), size: abs(Hstar) }]
          : [],
      burns: hedges.map((h) => h.tokenId),
      swapAtMint: true,
      H,
      Hstar,
      driftBps,
      triggers,
    }
  }

  // Off-side hedges (possible after restart adoption of manually-minted loans)
  // break two same-side assumptions. SHRINK handles it by burning net-side
  // hedges only (burning an off-side hedge moves H AWAY from the target); the
  // off-side position stays and keeps being netted into H — no burn-everything
  // slippage. The state-preserving capacity consolidate however sizes/one-sides
  // its remint assuming a single-sided book, so a mixed over-cap book is
  // rebuilt to |H*| instead (state-changing, swapAtMint=true: a one-time
  // slippage cost that also clears the self-offsetting pair).
  const netSide = tokenTypeForDirection(H > 0n, cfg.assetIndex)
  const mixedBook = H !== 0n && hedges.some((h) => h.tokenType !== netSide)
  if (mixedBook && overCap && !deltaDrift) return growConsolidate()

  // Capacity overlay short-circuits the state-preserving-only case. A
  // below-threshold sign change alone must not turn consolidation into a
  // delta-changing flip.
  if (overCap && !deltaDrift) return consolidate()

  // Classify.
  if (H === 0n && Hstar === 0n) return none()

  const openMint = (): PlannedMint => ({
    tokenType: tokenTypeForDirection(Hstar > 0n, cfg.assetIndex),
    size: abs(Hstar),
  })

  let result: PlanHedgeResult
  if (H === 0n) {
    // Case A — OPEN
    result = { ...none('open'), mints: [openMint()] }
  } else if (Hstar === 0n) {
    // Case B — CLOSE_ALL
    result = { ...none('close_all'), burns: hedges.map((h) => h.tokenId) }
  } else if (!sameSign(H, Hstar)) {
    // Case E — FLIP
    result = { ...none('flip'), mints: [openMint()], burns: hedges.map((h) => h.tokenId) }
  } else if (abs(Hstar) > abs(H)) {
    // Case C — GROW (same side, incremental)
    const sameSide = tokenTypeForDirection(Hstar > 0n, cfg.assetIndex)
    // GROW promotion when the extra leg would breach the cap: consolidate to |H*|.
    if (hedges.length + 1 > cfg.absoluteMaxHedgeCount) return growConsolidate()
    result = { ...none('grow'), mints: [{ tokenType: sameSide, size: abs(Hstar) - abs(H) }] }
  } else if (abs(Hstar) < abs(H)) {
    // Case D — SHRINK (reduce existing hedges, never offset). Only net-side
    // hedges are burn candidates: on a mixed book, burning an off-side hedge
    // would move H away from the target. Net-side size always covers
    // removeAmount (< |H| <= net-side total).
    const sameSide = tokenTypeForDirection(H > 0n, cfg.assetIndex)
    const removeAmount = abs(H) - abs(Hstar)
    const candidates = hedges.filter((h) => h.tokenType === sameSide)
    const sorted = [...candidates].sort((a, b) => (a.size < b.size ? -1 : a.size > b.size ? 1 : 0))
    const burns: bigint[] = []
    let remintSize: bigint | null = null
    let runningRemoved = 0n
    for (const h of sorted) {
      if (runningRemoved + h.size <= removeAmount) {
        burns.push(h.tokenId)
        runningRemoved += h.size
        if (runningRemoved === removeAmount) break
      } else {
        burns.push(h.tokenId)
        remintSize = h.size - (removeAmount - runningRemoved)
        break
      }
    }
    result = {
      ...none('shrink'),
      burns,
      mints:
        remintSize !== null && remintSize > 0n ? [{ tokenType: sameSide, size: remintSize }] : [],
    }
  } else {
    // Same side, equal magnitude — nothing to do (unless capacity fired above).
    return overCap ? consolidate() : none()
  }

  return result
}

// ---------------------------------------------------------------------------
// Orchestrator: reads chain state, computes P/C/H, calls planHedge, resolves
// planned mints into collision-free loan tokenIds, and returns a HedgeIntent.
// ---------------------------------------------------------------------------

export interface ComputeHedgePlanDeps {
  pool: HedgeSnapshot['pool']
  collateral: HedgeSnapshot['collateral']
  /** Loose collateral assets held by the Safe at the snapshot block. */
  walletBalances?: SafeWalletBalances
  /** Reference tick used to choose a collision-free loan strike. */
  signalTick: bigint
  assetIndex: 0n | 1n
  deltaThresholdBps: bigint
  timedHedgeMinDriftBps?: bigint
  timedHedgeDue?: boolean
  deltaOffsetBps: bigint
  absoluteMaxHedgeCount: number
  slippageBps: bigint
  /** Open positions held by the Safe (from positionReader). */
  positions: PositionSnapshot[]
  /** Subset of `positions` that are the bot's hedge loans. */
  hedgePositions: PositionSnapshot[]
  /**
   * Same-pair Uniswap LP positions (Safe + configured owner). Their delta is
   * always computed for reporting, but only ADDED to netDelta when `includeLp`.
   */
  lpPositions?: LpPositionForHedge[]
  /** Apply lpDelta to netDelta (HEDGE_INCLUDE_LP && subgraph fresh). */
  includeLp?: boolean
}

/** Itemized inputs to the delta calculation, for `inspect:hedge` / debugging. */
export interface HedgeDeltaBreakdown {
  /** Tick used to mark position/collateral deltas (median oracle / signal). */
  signalTick: bigint
  /** Live pool spot tick (used for swap tick limits, not delta marking). */
  poolCurrentTick: bigint
  assetIndex: 0n | 1n
  /** Per-position, per-leg delta contributions (vault-asset frame). */
  portfolio: PortfolioDeltaBreakdown
  /** Σ portfolio.total — delta of ALL open positions incl. hedge loans. */
  positionsDelta: bigint
  /** Raw CT collateral assets on each side (smallest units). */
  collateralToken0Assets: bigint
  collateralToken1Assets: bigint
  /** Loose Safe balances, with ETH + WETH combined on a native side. */
  walletToken0Assets: bigint
  walletToken1Assets: bigint
  /** Asset-side CT + loose-wallet collateral in the vault frame. */
  collateralDelta: bigint
  /** Delta of same-pair Uniswap LP positions (vault-asset frame). */
  lpDelta: bigint
  /** Whether lpDelta was applied to netDelta (vs observed-only). */
  lpIncluded: boolean
  /** positionsDelta + collateralDelta (+ lpDelta if applied) — drift is measured on this. */
  netDelta: bigint
  /** Hedge-book decomposition (vault-asset frame magnitudes). */
  hedges: HedgeItem[]
  H_short: bigint
  H_long: bigint
  /** H_long − H_short. */
  H: bigint
  portfolioSize: bigint
}

export interface HedgePlan extends PlanHedgeResult {
  intent: HedgeIntent
  netDelta: bigint
  portfolioSize: bigint
  breakdown: HedgeDeltaBreakdown
}

export type ComputeHedgeExposureDeps = Pick<
  ComputeHedgePlanDeps,
  | 'pool'
  | 'collateral'
  | 'walletBalances'
  | 'assetIndex'
  | 'positions'
  | 'hedgePositions'
  | 'lpPositions'
  | 'includeLp'
>

export interface HedgeExposure {
  netDelta: bigint
  portfolioSize: bigint
  H_short: bigint
  H_long: bigint
  hedgeItems: HedgeItem[]
  portfolioDelta: PortfolioDeltaBreakdown
  positionsDelta: bigint
  collateralDelta: bigint
  lpDelta: bigint
  lpIncluded: boolean
  walletBalances: SafeWalletBalances
}

/** Pure exposure calculation shared by authoritative planning and the fast price monitor. */
export function computeHedgeExposure(deps: ComputeHedgeExposureDeps): HedgeExposure {
  const { pool, collateral, assetIndex } = deps
  const markTick = pool.currentTick
  const tickSpacing = BigInt(pool.tickSpacing)
  const collateralAssetSide =
    assetIndex === 0n ? collateral.token0.assets : collateral.token1.assets
  const walletBalances = deps.walletBalances ?? EMPTY_SAFE_WALLET_BALANCES
  const walletAssetSide =
    assetIndex === 0n ? walletBalances.token0.total : walletBalances.token1.total
  const collateralDelta = toVaultFrameAtTick(
    collateralAssetSide + walletAssetSide,
    assetIndex,
    assetIndex,
    markTick,
  )

  const portfolioDelta = computePortfolioDeltaDetailed(
    deps.positions,
    markTick,
    tickSpacing,
    assetIndex,
  )
  const positionsDelta = portfolioDelta.total

  let lpDelta = 0n
  for (const lp of deps.lpPositions ?? []) {
    try {
      lpDelta += getLpGreeks({
        liquidity: lp.liquidity,
        tickLower: lp.tickLower,
        tickUpper: lp.tickUpper,
        currentTick: markTick,
        assetIndex: assetIndex === 0n ? 0 : 1,
      }).delta
    } catch {
      // A malformed LP position contributes no delta, matching authoritative planning.
    }
  }
  const lpIncluded = Boolean(deps.includeLp) && (deps.lpPositions?.length ?? 0) > 0
  const netDelta = positionsDelta + collateralDelta + (lpIncluded ? lpDelta : 0n)
  const portfolioSize = computePortfolioSizeInVaultAsset(deps.positions, assetIndex)

  let H_short = 0n
  let H_long = 0n
  const hedgeItems: HedgeItem[] = []
  for (const h of deps.hedgePositions) {
    let sizeMag = 0n
    let side: bigint | null = null
    for (const leg of h.legs) {
      if (leg.width !== 0n) continue
      if (side !== null && side !== leg.tokenType) {
        throw new Error(
          `hedge loan ${h.tokenId} has mixed-side zero-width legs; expected a single-side loan`,
        )
      }
      const notional = h.positionSize * leg.optionRatio
      const sizeVault = toVaultFrameAtSqrtPriceX96(
        notional,
        leg.asset,
        assetIndex,
        tickToSqrtPriceX96(leg.strike),
      )
      const mag = sizeVault < 0n ? -sizeVault : sizeVault
      sizeMag += mag
      side = leg.tokenType
      if (leg.tokenType === assetIndex) H_short += mag
      else H_long += mag
    }
    hedgeItems.push({ tokenId: h.tokenId, tokenType: side ?? assetIndex, size: sizeMag })
  }

  return {
    netDelta,
    portfolioSize,
    H_short,
    H_long,
    hedgeItems,
    portfolioDelta,
    positionsDelta,
    collateralDelta,
    lpDelta,
    lpIncluded,
    walletBalances,
  }
}

/**
 * Compute a full, execution-ready hedge plan for the current cycle.
 * The caller supplies the already-read positions (so position discovery and
 * hedge classification live in positionReader).
 */
export function computeHedgePlan(deps: ComputeHedgePlanDeps): HedgePlan {
  const { pool, collateral, signalTick, assetIndex } = deps
  const tickSpacing = BigInt(pool.tickSpacing)
  const poolId = pool.poolId
  const openIds = deps.positions.map((p) => p.tokenId)
  const exposure = computeHedgeExposure(deps)
  const {
    netDelta,
    portfolioSize,
    H_short,
    H_long,
    hedgeItems,
    portfolioDelta,
    positionsDelta,
    collateralDelta,
    lpDelta,
    lpIncluded,
    walletBalances,
  } = exposure

  const plan = planHedge(netDelta, H_short, H_long, hedgeItems, portfolioSize, {
    assetIndex,
    deltaThresholdBps: deps.deltaThresholdBps,
    timedHedgeMinDriftBps: deps.timedHedgeMinDriftBps,
    timedHedgeDue: deps.timedHedgeDue,
    deltaOffsetBps: deps.deltaOffsetBps,
    absoluteMaxHedgeCount: deps.absoluteMaxHedgeCount,
  })

  // Resolve at most one planned mint into a collision-free loan tokenId.
  // Floor-divide (bigint `/` truncates toward zero, which rounds negative,
  // non-aligned ticks the wrong way — into the higher spacing bucket).
  const spacingQuotient =
    signalTick / tickSpacing - (signalTick % tickSpacing !== 0n && signalTick < 0n ? 1n : 0n)
  const roundedStrike = spacingQuotient * tickSpacing
  let openTokenId: bigint | null = null
  let openPositionSize: bigint | null = null
  let skippedCollidingTokenIds: bigint[] = []
  if (plan.mints.length > 0) {
    const mint = plan.mints[0]
    const built = buildUniqueLoan(
      poolId,
      { asset: assetIndex, tokenType: mint.tokenType, strike: roundedStrike },
      openIds,
      mint.size,
    )
    openTokenId = built.tokenId
    openPositionSize = built.adjustedSize
    skippedCollidingTokenIds = built.skippedCollidingTokenIds
  }

  const intent: HedgeIntent = {
    action: plan.action,
    openTokenId,
    openPositionSize,
    swapAtMint: plan.swapAtMint,
    closeTokenIds: plan.burns,
    existingPositionIds: openIds,
    skippedCollidingTokenIds,
    // Execution limits are evaluated against pool spot, not the reference signal.
    currentTick: pool.currentTick,
    slippageBps: deps.slippageBps,
  }

  const breakdown: HedgeDeltaBreakdown = {
    signalTick,
    poolCurrentTick: pool.currentTick,
    assetIndex,
    portfolio: portfolioDelta,
    positionsDelta,
    collateralToken0Assets: collateral.token0.assets,
    collateralToken1Assets: collateral.token1.assets,
    walletToken0Assets: walletBalances.token0.total,
    walletToken1Assets: walletBalances.token1.total,
    collateralDelta,
    lpDelta,
    lpIncluded,
    netDelta,
    hedges: hedgeItems,
    H_short,
    H_long,
    H: H_long - H_short,
    portfolioSize,
  }

  return { ...plan, intent, netDelta, portfolioSize, breakdown }
}
