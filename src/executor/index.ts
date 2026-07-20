import type { Address, PublicClient } from 'viem'

import type { HedgerBotConfig } from '../config'
import type { RolesExecutor } from '../safe/rolesExecutor'
import { createSamePoolLoanExecutor } from './samePoolLoanExecutor'
import type { HedgeExecutor } from './types'

export { createSamePoolLoanExecutor } from './samePoolLoanExecutor'
export type {
  HedgeAction,
  HedgeContext,
  HedgeExecutionResult,
  HedgeExecutor,
  HedgeFinalStatePreview,
  HedgeIntent,
} from './types'

export interface CreateHedgeExecutorDeps {
  poolAddress: Address
  publicClient: PublicClient
  rolesExecutor: RolesExecutor
  builderCode?: bigint
}

/**
 * Construct the supported in-pool loan executor.
 */
export function createHedgeExecutor(
  config: HedgerBotConfig,
  deps: CreateHedgeExecutorDeps,
): HedgeExecutor {
  return createSamePoolLoanExecutor({
    poolAddress: deps.poolAddress,
    publicClient: deps.publicClient,
    safeAddress: config.SAFE_ADDRESS,
    rolesExecutor: deps.rolesExecutor,
    builderCode: deps.builderCode,
    dryRun: config.DRY_RUN,
  })
}
