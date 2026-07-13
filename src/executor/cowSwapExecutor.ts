import type { HedgeExecutor } from './types'

export interface CowSwapExecutorDeps {
  chainId: bigint
}

/**
 * STUB (feature 4). Same as the cross-pool executor but routes the asset buy/sell
 * through CoW Swap (SDK `quoteCowSwap` + `signAndSubmitCowOrder`) instead of the
 * Uniswap v4 router. Not implemented in v1.
 */
export function createCowSwapExecutor(_deps: CowSwapExecutorDeps): HedgeExecutor {
  throw new Error('cowswap hedge executor is not implemented in v1 (use same-pool-loan)')
}
