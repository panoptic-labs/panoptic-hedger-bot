import type { PoolHealthStatus } from '@panoptic-eng/sdk/v2'
import { isLiquidatable } from '@panoptic-eng/sdk/v2'
import type { Address, PublicClient } from 'viem'

import { asSdkClient } from '../utils/sdkClient'

export interface SafetyDeps {
  publicClient: PublicClient
  poolAddress: Address
  safeAddress: Address
  /** Open position tokenIds held by the Safe. */
  tokenIds: bigint[]
  /** Pool health from getPool. */
  poolHealthStatus: PoolHealthStatus
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
 * v1 gates on `isLiquidatable` + pool health. A margin-buffer percentage (via
 * getMarginBuffer, which needs the PanopticQuery address) is a future add.
 */
export async function assessSafety(deps: SafetyDeps): Promise<SafetyAssessment> {
  const { publicClient, poolAddress, safeAddress, tokenIds, poolHealthStatus } = deps
  const reasons: string[] = []

  const liq = await isLiquidatable({
    client: asSdkClient<typeof isLiquidatable>(publicClient),
    poolAddress,
    account: safeAddress,
    tokenIds,
  })

  if (liq.isLiquidatable) reasons.push('account is liquidatable')
  if (poolHealthStatus === 'paused') reasons.push('pool is paused')

  return { safe: reasons.length === 0, reasons, isLiquidatable: liq.isLiquidatable }
}
