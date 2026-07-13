import type { Address, PublicClient } from 'viem'

import type { HedgerBotConfig } from '../config'
import type { RolesExecutor } from '../safe/rolesExecutor'
import { createCrossPoolExecutor } from './crossPoolExecutor'
import { createSamePoolLoanExecutor } from './samePoolLoanExecutor'
import type { HedgeExecutor } from './types'

export { createCrossPoolExecutor } from './crossPoolExecutor'
export { createSamePoolLoanExecutor } from './samePoolLoanExecutor'
export type {
  HedgeAction,
  HedgeContext,
  HedgeExecutionResult,
  HedgeExecutor,
  HedgeIntent,
} from './types'

export interface CreateHedgeExecutorDeps {
  publicClient: PublicClient
  poolAddress: Address
  safeAddress: Address
  rolesExecutor: RolesExecutor
  builderCode?: bigint
}

/**
 * Construct the hedge executor for the configured venue.
 * - 'in-pool' (v1): same-pool loan hedge.
 * - 'cross-pool-uniswap': spot rebalance on another pool, with the in-pool loan
 *   executor as the wholesale fallback when margin can't cover the swap.
 */
export function createHedgeExecutor(
  config: HedgerBotConfig,
  deps: CreateHedgeExecutorDeps,
): HedgeExecutor {
  const inPool = createSamePoolLoanExecutor({
    poolAddress: deps.poolAddress,
    rolesExecutor: deps.rolesExecutor,
    builderCode: deps.builderCode,
    dryRun: config.DRY_RUN,
  })

  if (config.HEDGE_VENUE === 'in-pool') return inPool

  // config.superRefine guarantees these are present for cross-pool-uniswap.
  return createCrossPoolExecutor({
    publicClient: deps.publicClient,
    chainId: BigInt(config.CHAIN_ID),
    safeAddress: deps.safeAddress,
    rolesExecutor: deps.rolesExecutor,
    fallback: inPool,
    universalRouter: config.UNIVERSAL_ROUTER_ADDRESS as Address,
    multiSend: config.MULTISEND_ADDRESS as Address,
    hedgePools: config.HEDGE_POOLS ?? [],
    assetIndex: config.ASSET_INDEX as 0n | 1n,
    slippageBps: BigInt(config.SLIPPAGE_BPS),
    dryRun: config.DRY_RUN,
  })
}
