import type { PoolHealthStatus } from '@panoptic-eng/sdk/v2'

import { isDeleverageTriggered } from './deleverage'

export interface SafetyDeps {
  poolHealthStatus: PoolHealthStatus
  isLiquidatable: boolean
  /**
   * Deleverage inputs. When provided AND the trigger fires, the verdict is
   * 'deleverage' instead of 'skip' — even when the pool is paused, because a
   * paused (safe-mode) pool is burn/close-only: mints revert but the emergency
   * force-close burns proceed. Omit to keep the legacy skip-only behavior.
   */
  deleverage?: {
    enabled: boolean
    bufferBps: bigint
    triggerMarginBps: bigint
  }
}

/**
 * Three-way outcome:
 *  - 'hedge'      — healthy; proceed with normal hedge planning.
 *  - 'deleverage' — at risk AND the deleverager is enabled; force-close to de-risk.
 *  - 'skip'       — at risk with no deleverager, or paused with nothing to de-risk.
 */
export type SafetyVerdict = 'hedge' | 'deleverage' | 'skip'

export interface SafetyAssessment {
  /** Whether it is safe to mint/adjust hedges this cycle. */
  safe: boolean
  verdict: SafetyVerdict
  reasons: string[]
  isLiquidatable: boolean
  /**
   * Pool is in safe-mode (close-only): mints revert but burns proceed. The
   * deleverage path must restrict its in-cycle rehedge to loan BURNS.
   */
  paused: boolean
}

/**
 * Gate hedging on account/pool health. When at risk (near liquidation or low
 * margin buffer) the bot either actively de-risks (deleverager enabled) or
 * skips and alerts.
 *
 * A paused pool blocks the normal HEDGE path (mints revert in safe-mode) but
 * NOT deleveraging: a paused pool is burn/close-only, so the emergency
 * force-close is exactly the action that still works — and matters most.
 *
 * Chain reads live in the block-pinned snapshot module; this function is pure.
 */
export function assessSafety(deps: SafetyDeps): SafetyAssessment {
  const reasons: string[] = []
  if (deps.isLiquidatable) reasons.push('account is liquidatable')
  const paused = deps.poolHealthStatus === 'paused'
  if (paused) reasons.push('pool is paused (close-only)')

  const atRisk =
    deps.deleverage !== undefined &&
    isDeleverageTriggered({
      isLiquidatable: deps.isLiquidatable,
      bufferBps: deps.deleverage.bufferBps,
      triggerMarginBps: deps.deleverage.triggerMarginBps,
    })

  // Distinguish a low-buffer trigger from a hard liquidatable flag in reasons.
  if (atRisk && !deps.isLiquidatable && deps.deleverage) {
    reasons.push(
      `margin buffer ${deps.deleverage.bufferBps}bps below ` +
        `${deps.deleverage.triggerMarginBps}bps trigger`,
    )
  }

  // Single mutually-exclusive decision. Deleveraging is allowed even while
  // paused (burns still land); only the normal hedge path is blocked by pause.
  // `atRisk` alone can be false when no deleverage inputs are supplied, so fold
  // in the raw liquidatable flag.
  const risky = atRisk || deps.isLiquidatable
  let verdict: SafetyVerdict
  if (risky) {
    verdict = deps.deleverage?.enabled && atRisk ? 'deleverage' : 'skip'
  } else if (paused) {
    verdict = 'skip'
  } else {
    verdict = 'hedge'
  }

  return {
    safe: reasons.length === 0,
    verdict,
    reasons,
    isLiquidatable: deps.isLiquidatable,
    paused,
  }
}
