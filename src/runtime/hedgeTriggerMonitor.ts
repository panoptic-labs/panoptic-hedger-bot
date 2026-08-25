import { tickToPriceDecimalScaled } from '@panoptic-eng/sdk/v2'

import { computeHedgeDrift, computeHedgeExposure } from '../hedge/decision'
import type { HedgeSnapshot } from '../hedge/snapshot'

const MIN_TICK = -887_272n
const MAX_TICK = 887_272n

export type HedgeMonitorMode = 'boundaries' | 'local-eval'
export type HedgeWakeReason = 'hedge-approach' | 'hedge-crossed'

export interface HedgeTriggerConfig {
  assetIndex: 0n | 1n
  deltaThresholdBps: bigint
  deltaOffsetBps: bigint
  includeLp: boolean
}

export interface HedgeTickBoundaries {
  approachDown?: bigint
  approachUp?: bigint
  triggerDown?: bigint
  triggerUp?: bigint
}

export interface HedgeTriggerStatus extends HedgeTickBoundaries {
  mode: HedgeMonitorMode
  snapshotBlock: bigint
  snapshotTick: bigint
  latestTick: bigint
  driftBps: bigint
}

export interface HedgeTickObservation {
  reason?: HedgeWakeReason
  status: HedgeTriggerStatus
}

export interface HedgeTriggerPriceContext {
  token0Decimals: bigint
  token1Decimals: bigint
  token0Symbol: string
  token1Symbol: string
}

/** One-line operator view shared by the daemon log and inspect:hedge. */
export function formatHedgeTriggerStatus(
  status: HedgeTriggerStatus,
  context: HedgeTriggerPriceContext,
): string {
  const token1PerToken0 = tickToPriceDecimalScaled(
    status.latestTick,
    context.token0Decimals,
    context.token1Decimals,
    6n,
  )
  const invert = Number(token1PerToken0) < 1
  const priceAt = (tick: bigint | undefined): string => {
    if (tick === undefined) return 'none'
    return invert
      ? tickToPriceDecimalScaled(-tick, context.token1Decimals, context.token0Decimals, 6n)
      : tickToPriceDecimalScaled(tick, context.token0Decimals, context.token1Decimals, 6n)
  }
  const pair = invert
    ? `${context.token0Symbol}/${context.token1Symbol}`
    : `${context.token1Symbol}/${context.token0Symbol}`
  const currentPrice = invert
    ? tickToPriceDecimalScaled(
        -status.latestTick,
        context.token1Decimals,
        context.token0Decimals,
        6n,
      )
    : token1PerToken0
  // Inverting the quote reverses tick direction, so map the cached boundaries
  // back to economically lower/higher prices for operator-facing down/up labels.
  const downTick = invert ? status.triggerUp : status.triggerDown
  const upTick = invert ? status.triggerDown : status.triggerUp
  const approachDownTick = invert ? status.approachUp : status.approachDown
  const approachUpTick = invert ? status.approachDown : status.approachUp
  return (
    `hedge-trigger prices mode=${status.mode} pair=${pair} current=${currentPrice} ` +
    `down=${priceAt(downTick)} up=${priceAt(upTick)} ` +
    `approachDown=${priceAt(approachDownTick)} approachUp=${priceAt(approachUpTick)}`
  )
}

type DriftEvaluator = (tick: bigint) => bigint

/** Find the closest ticks on each side whose drift is strictly above `thresholdBps`. */
export function findDriftBoundaries(
  currentTick: bigint,
  thresholdBps: bigint,
  driftAt: DriftEvaluator,
): { down?: bigint; up?: bigint } {
  if (driftAt(currentTick) > thresholdBps) return { down: currentTick, up: currentTick }

  const findUp = (): bigint | undefined => {
    let safe = currentTick
    let step = 1n
    while (safe < MAX_TICK) {
      const candidate = safe + step > MAX_TICK ? MAX_TICK : safe + step
      if (driftAt(candidate) > thresholdBps) {
        let triggered = candidate
        while (triggered - safe > 1n) {
          const mid = safe + (triggered - safe) / 2n
          if (driftAt(mid) > thresholdBps) triggered = mid
          else safe = mid
        }
        return triggered
      }
      if (candidate === MAX_TICK) return undefined
      safe = candidate
      step *= 2n
    }
    return undefined
  }

  const findDown = (): bigint | undefined => {
    let safe = currentTick
    let step = 1n
    while (safe > MIN_TICK) {
      const candidate = safe - step < MIN_TICK ? MIN_TICK : safe - step
      if (driftAt(candidate) > thresholdBps) {
        let triggered = candidate
        while (safe - triggered > 1n) {
          const mid = triggered + (safe - triggered) / 2n
          if (driftAt(mid) > thresholdBps) triggered = mid
          else safe = mid
        }
        return triggered
      }
      if (candidate === MIN_TICK) return undefined
      safe = candidate
      step *= 2n
    }
    return undefined
  }

  return { down: findDown(), up: findUp() }
}

export function hedgeMonitorMode(snapshot: HedgeSnapshot, includeLp: boolean): HedgeMonitorMode {
  const optionDirections = new Set<boolean>()
  for (const position of snapshot.positions) {
    for (const leg of position.legs) {
      if (leg.width > 0n) optionDirections.add(leg.isLong)
    }
  }
  if (optionDirections.size > 1) return 'local-eval'
  const onlyDirection = optionDirections.values().next().value
  // LP delta and long-option gamma can oppose each other. Keep that combination
  // on exact local evaluation rather than claiming a monotonic boundary.
  return onlyDirection === true && includeLp && (snapshot.lp?.positions.length ?? 0) > 0
    ? 'local-eval'
    : 'boundaries'
}

function crossed(tick: bigint, down?: bigint, up?: bigint): boolean {
  return (down !== undefined && tick <= down) || (up !== undefined && tick >= up)
}

/**
 * Holds one authoritative account snapshot and turns cheap spot-tick reads into
 * wake-up hints. A wake never authorizes execution: the normal cycle re-reads
 * all account state before it can submit anything.
 */
export class HedgeTriggerMonitor {
  private readonly config: HedgeTriggerConfig
  private state:
    | {
        snapshot: HedgeSnapshot
        mode: HedgeMonitorMode
        boundaries: HedgeTickBoundaries
        driftAt: DriftEvaluator
        approachLatched: boolean
        crossingLatched: boolean
      }
    | undefined

  constructor(config: HedgeTriggerConfig) {
    this.config = config
  }

  refresh(snapshot: HedgeSnapshot): HedgeTriggerStatus {
    const driftAt = (tick: bigint): bigint => {
      const exposure = computeHedgeExposure({
        pool: { ...snapshot.pool, currentTick: tick },
        collateral: snapshot.collateral,
        walletBalances: snapshot.walletBalances,
        assetIndex: this.config.assetIndex,
        positions: snapshot.positions,
        hedgePositions: snapshot.hedgePositions,
        lpPositions: snapshot.lp?.positions,
        includeLp: this.config.includeLp && snapshot.lp?.fresh === true,
      })
      return computeHedgeDrift(
        exposure.netDelta,
        exposure.H_short,
        exposure.H_long,
        exposure.portfolioSize,
        this.config.deltaOffsetBps,
      ).driftBps
    }
    const mode = hedgeMonitorMode(snapshot, this.config.includeLp)
    const approachThreshold = (this.config.deltaThresholdBps * 9n) / 10n
    const approach =
      mode === 'boundaries'
        ? findDriftBoundaries(snapshot.pool.currentTick, approachThreshold, driftAt)
        : {}
    const trigger =
      mode === 'boundaries'
        ? findDriftBoundaries(snapshot.pool.currentTick, this.config.deltaThresholdBps, driftAt)
        : {}
    const boundaries: HedgeTickBoundaries = {
      approachDown: approach.down,
      approachUp: approach.up,
      triggerDown: trigger.down,
      triggerUp: trigger.up,
    }
    const currentDriftBps = driftAt(snapshot.pool.currentTick)
    this.state = {
      snapshot,
      mode,
      boundaries,
      driftAt,
      approachLatched: currentDriftBps > approachThreshold,
      crossingLatched: currentDriftBps > this.config.deltaThresholdBps,
    }
    return this.status(snapshot.pool.currentTick, currentDriftBps)
  }

  invalidate(): void {
    this.state = undefined
  }

  observe(tick: bigint): HedgeTickObservation | undefined {
    const state = this.state
    if (!state) return undefined

    const driftBps = state.driftAt(tick)
    const hardCrossed =
      state.mode === 'boundaries'
        ? crossed(tick, state.boundaries.triggerDown, state.boundaries.triggerUp)
        : driftBps > this.config.deltaThresholdBps
    const approachCrossed =
      state.mode === 'boundaries'
        ? crossed(tick, state.boundaries.approachDown, state.boundaries.approachUp)
        : driftBps > (this.config.deltaThresholdBps * 9n) / 10n

    if (driftBps <= (this.config.deltaThresholdBps * 8n) / 10n) {
      state.approachLatched = false
      state.crossingLatched = false
    }

    let reason: HedgeWakeReason | undefined
    if (hardCrossed && !state.crossingLatched) {
      state.crossingLatched = true
      state.approachLatched = true
      reason = 'hedge-crossed'
    } else if (approachCrossed && !state.approachLatched) {
      state.approachLatched = true
      reason = 'hedge-approach'
    }
    return { reason, status: this.status(tick, driftBps) }
  }

  private status(tick: bigint, driftBps?: bigint): HedgeTriggerStatus {
    const state = this.state
    if (!state) throw new Error('hedge trigger monitor has no snapshot')
    return {
      mode: state.mode,
      snapshotBlock: state.snapshot.blockNumber,
      snapshotTick: state.snapshot.pool.currentTick,
      latestTick: tick,
      driftBps: driftBps ?? state.driftAt(tick),
      ...state.boundaries,
    }
  }
}
