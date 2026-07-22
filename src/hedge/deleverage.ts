import type { MarginSnapshot } from './marginReserve'

/**
 * Emergency deleverager decision logic (pure — no chain I/O).
 *
 * When the account is liquidatable or its distance to liquidation (the "margin
 * buffer") falls below the trigger, the bot force-closes positions to de-risk
 * instead of only alerting. This module computes the trigger, tracks the
 * incident (hysteresis + per-stage cooldown so a burn whose effect hasn't
 * landed doesn't re-fire every poll), and greedily selects which option
 * positions to burn — verifying each step through an injected simulator so a
 * burn is emitted only when it actually improves the buffer.
 */

const BPS = 10_000n

/**
 * Sentinel buffer for an account with no margin requirement (no positions /
 * nothing at risk). Far above any configurable trigger/target so it never fires.
 */
export const BUFFER_NO_RISK = 1_000_000_000n

/**
 * Account-level, cross-collateral distance to liquidation, in bps of the
 * required margin: `(currentMargin - requiredMargin) * 1e4 / requiredMargin`.
 *
 * The SDK returns the gross (current) and required margin cross-converted into
 * BOTH token frames — economically the same quantity, so the ratio is
 * frame-invariant; we take the min across the two frames to stay conservative
 * against integer rounding. A shortfall (current < required) clamps to 0; a
 * zero requirement returns {@link BUFFER_NO_RISK}. This is the canonical health
 * metric — prefer it over ad-hoc free/gross-collateral reserve ratios.
 */
function bufferBpsFromMargins(
  current0: bigint,
  required0: bigint,
  current1: bigint,
  required1: bigint,
): bigint {
  const side = (current: bigint, required: bigint): bigint | null => {
    if (required <= 0n) return null
    const excess = current - required
    return excess <= 0n ? 0n : (excess * BPS) / required
  }
  const b0 = side(current0, required0)
  const b1 = side(current1, required1)
  if (b0 === null && b1 === null) return BUFFER_NO_RISK
  if (b0 === null) return b1 as bigint
  if (b1 === null) return b0
  return b0 < b1 ? b0 : b1
}

/** Margin buffer from the SDK liquidation check (drives the trigger). */
export function computeLiquidationBufferBps(liq: {
  currentMargin0: bigint
  requiredMargin0: bigint
  currentMargin1: bigint
  requiredMargin1: bigint
}): bigint {
  return bufferBpsFromMargins(
    liq.currentMargin0,
    liq.requiredMargin0,
    liq.currentMargin1,
    liq.requiredMargin1,
  )
}

/**
 * Same margin buffer computed from a post-dispatch {@link MarginSnapshot} (the
 * shape `previewFinalState` returns), so simulated ranking uses the same metric
 * as the live trigger.
 */
export function computeMarginBufferBps(margin: MarginSnapshot): bigint {
  return bufferBpsFromMargins(
    margin.collateralBalance0,
    margin.requiredCollateral0,
    margin.collateralBalance1,
    margin.requiredCollateral1,
  )
}

export interface DeleverageTriggerInput {
  isLiquidatable: boolean
  bufferBps: bigint
  triggerMarginBps: bigint
}

/** True when the account should be actively de-risked this cycle. */
export function isDeleverageTriggered(input: DeleverageTriggerInput): boolean {
  return input.isLiquidatable || input.bufferBps < input.triggerMarginBps
}

export type DeleverageStage = 'loans' | 'options'

/**
 * In-memory incident state machine. An incident opens on the first trigger and
 * closes only when the reserve recovers to the target (hysteresis). While open,
 * each stage is throttled by a cooldown so an in-flight burn isn't re-issued
 * before its effect is observable on-chain.
 */
export class DeleverageIncident {
  private open = false
  private readonly lastStageAtMs = new Map<DeleverageStage, number>()
  private readonly targetMarginBps: bigint
  private readonly cooldownMs: number

  constructor(targetMarginBps: bigint, cooldownMs: number) {
    this.targetMarginBps = targetMarginBps
    this.cooldownMs = cooldownMs
  }

  get active(): boolean {
    return this.open
  }

  /** Record the current observation; returns whether an incident is now active. */
  observe(input: DeleverageTriggerInput): boolean {
    if (isDeleverageTriggered(input)) {
      this.open = true
    } else if (input.bufferBps >= this.targetMarginBps) {
      // Recovered past the hysteresis line — close the incident and reset cooldowns.
      this.open = false
      this.lastStageAtMs.clear()
    }
    return this.open
  }

  /** Whether a stage may fire now (cooldown elapsed since its last attempt). */
  canRunStage(stage: DeleverageStage, nowMs: number): boolean {
    const last = this.lastStageAtMs.get(stage)
    return last === undefined || nowMs - last >= this.cooldownMs
  }

  markStageRun(stage: DeleverageStage, nowMs: number): void {
    this.lastStageAtMs.set(stage, nowMs)
  }
}

export interface BurnCandidate {
  tokenId: bigint
  /**
   * Pre-sort key: |delta| of the option in the vault frame. Closing the
   * largest-|delta| options unwinds the most hedge loans, so they tend to
   * relieve the most margin — try them first to reach the target with the
   * fewest user positions force-closed. Optional (falls back to input order).
   */
  absDelta?: bigint
}

/**
 * Simulate the CLOSE + REHEDGE of a set of option tokenIds — burn the options
 * AND re-neutralize the freed delta on the reduced book — and return the
 * resulting margin buffer (bps), or null when the simulation fails/reverts.
 * Injected so the selection heuristic stays pure and unit-testable.
 */
export type BurnSimulator = (tokenIds: bigint[]) => Promise<bigint | null>

export interface SelectOptionBurnsResult {
  /** Ordered tokenIds to burn (largest close+rehedge buffer impact first). */
  tokenIds: bigint[]
  /** Simulated margin buffer after close+rehedge of the selected set (null = no viable set). */
  projectedBufferBps: bigint | null
  /** True when the target could not be reached and we fell back to burning all. */
  burnedAll: boolean
}

/**
 * Greedily pick option positions to burn, ranking by the margin-buffer impact
 * of CLOSING each option AND rehedging the freed delta (the simulator models
 * both). Candidates are first ordered by |delta| (pre-sort) so the
 * biggest-impact closes are attempted first, then accumulated — re-simulating
 * the combined close+rehedge — until the target buffer is reached. If no subset
 * reaches the target, fall back to burning every candidate (last resort against
 * a liquidation penalty).
 */
export async function selectOptionBurns(params: {
  candidates: BurnCandidate[]
  targetMarginBps: bigint
  simulate: BurnSimulator
}): Promise<SelectOptionBurnsResult> {
  const { candidates, targetMarginBps, simulate } = params
  if (candidates.length === 0) {
    return { tokenIds: [], projectedBufferBps: null, burnedAll: false }
  }

  // Score each candidate by its individual close+rehedge buffer impact. Pre-sort
  // by |delta| so ties / equal-cost sims keep the biggest-impact option first.
  const preSorted = [...candidates].sort((a, b) => {
    const da = a.absDelta ?? 0n
    const db = b.absDelta ?? 0n
    return da > db ? -1 : da < db ? 1 : 0
  })
  const scored = await Promise.all(
    preSorted.map(async (candidate) => ({
      tokenId: candidate.tokenId,
      buffer: await simulate([candidate.tokenId]),
    })),
  )
  scored.sort((a, b) => {
    if (a.buffer === null) return b.buffer === null ? 0 : 1
    if (b.buffer === null) return -1
    return a.buffer > b.buffer ? -1 : a.buffer < b.buffer ? 1 : 0
  })

  const selected: bigint[] = []
  let projected: bigint | null = null
  for (const entry of scored) {
    selected.push(entry.tokenId)
    projected = await simulate(selected)
    if (projected !== null && projected >= targetMarginBps) {
      return { tokenIds: selected, projectedBufferBps: projected, burnedAll: false }
    }
  }

  // No subset reached the target — burn everything as a last resort.
  const all = preSorted.map((c) => c.tokenId)
  const allBuffer = await simulate(all)
  return { tokenIds: all, projectedBufferBps: allBuffer, burnedAll: true }
}
