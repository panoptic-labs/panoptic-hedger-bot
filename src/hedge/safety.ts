import type { PoolHealthStatus } from '@panoptic-eng/sdk/v2'

export interface SafetyDeps {
  poolHealthStatus: PoolHealthStatus
  isLiquidatable: boolean
}

export interface SafetyAssessment {
  /** Whether it is safe to mint/adjust hedges this cycle. */
  safe: boolean
  reasons: string[]
  isLiquidatable: boolean
}

/**
 * Gate hedging on account/pool health. When unsafe (near liquidation or paused
 * pool) the caller should skip hedging and alert — never widen risk near
 * liquidation.
 *
 * Chain reads live in the block-pinned snapshot module; this function is pure.
 */
export function assessSafety(deps: SafetyDeps): SafetyAssessment {
  const reasons: string[] = []
  if (deps.isLiquidatable) reasons.push('account is liquidatable')
  if (deps.poolHealthStatus === 'paused') reasons.push('pool is paused')

  return { safe: reasons.length === 0, reasons, isLiquidatable: deps.isLiquidatable }
}
