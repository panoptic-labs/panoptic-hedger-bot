import { parsePanopticError, quoteV3ExactIn, simulateBatchDispatch } from '@panoptic-eng/sdk/v2'
import type { Address, PublicClient } from 'viem'
import { parseAbi } from 'viem'

import { buildHedgeBatchOps, buildOffVenueHedgeBatchOps } from '../executor/dispatchCalldata'
import { shouldUseSfpmVenue } from '../executor/sfpmVenue'
import type { HedgeIntent } from '../executor/types'
import { botLog } from '../utils/log'
import { asSdkClient } from '../utils/sdkClient'
import type { SwapPoolMapping } from './sfpmVenueRouter'

const slot0Abi = parseAbi([
  'function slot0() view returns (uint160 sqrtPriceX96, int24 tick, uint16 a, uint16 b, uint16 c, uint8 d, bool e)',
])

const absBig = (x: bigint): bigint => (x < 0n ? -x : x)

/** Outcome of evaluating the off-venue route for a single hedge intent. */
export interface SfpmVenueDecision {
  /** True when the SFPM venue should be used (savings clear the threshold). */
  use: boolean
  /** Sell the v3 pool's token0 for token1 (`true`) or the reverse — from the net delta. */
  sellToken0: boolean
  /** Exact imbalance to swap off-venue, in the sold token (options collateral units). */
  swapAmount: bigint
  /** Quoted output of the 5bps swap (QuoterV2) — the executor's deposit-floor basis. */
  amountOut: bigint
  /** Current tick of the v3 swap pool (for the swap band). */
  swapPoolTick: number
}

export interface SfpmSwapQuote {
  amountOut: bigint
  swapPoolTick: number
}

export interface SfpmVenueCoordinatorDeps {
  publicClient: PublicClient
  /** Options (Panoptic) pool. */
  poolAddress: Address
  safeAddress: Address
  builderCode: bigint
  chainId: bigint
  /** v3 swap pool + its token0/token1 (by address) and fee tier. */
  swapPoolAddress: Address
  swapToken0: Address
  swapToken1: Address
  swapFee: bigint
  /** Options-collateral ↔ swap-token mapping (for net-delta swap direction). */
  mapping: SwapPoolMapping
  slippageBps: bigint
  minSavingsBps: bigint
}

/**
 * Decide whether a hedge's `swapAtMint` swap should run off-venue, and size it.
 *
 * The exact amount cannot be read off the intent (a loan's tokenType usually
 * differs from its asset index, so the moved amount is strike-converted). Instead
 * we simulate the dispatch with `swapAtMint` both ways and take the collateral
 * delta *difference* — that IS the swap the in-pool `swapAtMint` performs:
 *   - the sold-token side's magnitude → the exact amount to swap off-venue;
 *   - the bought-token side's magnitude → the in-pool output, the reference the
 *     savings threshold compares the SFPM quote against.
 *
 * Returns `null` (⇒ stay in-pool) if either simulation fails, the imbalance is
 * zero, or the SFPM quote reverts.
 */
export function createSfpmVenueCoordinator(deps: SfpmVenueCoordinatorDeps) {
  const {
    publicClient,
    poolAddress,
    safeAddress,
    builderCode,
    chainId,
    swapPoolAddress,
    swapToken0,
    swapToken1,
    swapFee,
    mapping,
    slippageBps,
    minSavingsBps,
  } = deps

  async function simulateDelta(intent: HedgeIntent, swapAtMint: boolean) {
    const sim = await simulateBatchDispatch({
      client: asSdkClient<typeof simulateBatchDispatch>(publicClient),
      poolAddress,
      account: safeAddress,
      items: swapAtMint
        ? buildHedgeBatchOps({ ...intent, swapAtMint: true }, poolAddress)
        : buildOffVenueHedgeBatchOps(intent, poolAddress),
      existingPositionIds: intent.existingPositionIds,
      usePremiaAsCollateral: false,
      builderCode,
    })
    if (!sim.success) {
      let detail = 'reverted'
      if ('error' in sim && sim.error) {
        const parsed = parsePanopticError(sim.error)
        detail = parsed
          ? `${parsed.errorName}(${parsed.args.map(String).join(', ')})`
          : sim.error.message
      } else if (
        'diagnostics' in sim &&
        Array.isArray(sim.diagnostics) &&
        sim.diagnostics.length > 0
      )
        detail = sim.diagnostics.map((d) => d.message).join('; ')
      botLog(`[sfpm-venue]   swapAtMint=${swapAtMint} sim failed: ${detail.slice(0, 240)}`)
      return null
    }
    if (!sim.tokenFlow) {
      botLog(`[sfpm-venue]   swapAtMint=${swapAtMint} sim ok but returned no tokenFlow`)
      return null
    }
    return { delta0: sim.tokenFlow.delta0, delta1: sim.tokenFlow.delta1 }
  }

  async function evaluate(intent: HedgeIntent): Promise<SfpmVenueDecision | null> {
    const withSwap = await simulateDelta(intent, true)
    const withoutSwap = await simulateDelta(intent, false)
    if (!withSwap || !withoutSwap) {
      botLog('[sfpm-venue] decline: dispatch simulation failed (swapAtMint true/false)')
      return null
    }

    // The in-pool swapAtMint's net effect = the collateral-delta difference.
    // This is the exact swap the off-venue path must replicate, aggregated across
    // all burns + mints — so direction comes from the net delta, not any leg.
    const dd0 = withSwap.delta0 - withoutSwap.delta0
    const dd1 = withSwap.delta1 - withoutSwap.delta1
    // A swap moves the two collateral sides in opposite directions. If they don't
    // (both same sign / zero), there is no clean single-direction swap → stay in-pool.
    if (dd0 === 0n || dd1 === 0n || dd0 < 0n === dd1 < 0n) {
      botLog(
        `[sfpm-venue] decline: net swap delta not a clean single direction (dd0=${dd0} dd1=${dd1})`,
      )
      return null
    }

    const soldIsToken0 = dd0 < 0n // the side the swap removes from collateral is sold
    const swapAmount = absBig(soldIsToken0 ? dd0 : dd1) // sold side (input)
    const inPoolAmountOut = absBig(soldIsToken0 ? dd1 : dd0) // bought side (in-pool output)

    // Map the sold options-collateral side to the v3 pool's token index.
    const sellSwapIndex = mapping.tokenTypeToSwapIndex[soldIsToken0 ? 0 : 1]
    const sellToken0 = sellSwapIndex === 0

    const quote = await quoteSwap(sellToken0, swapAmount)
    if (!quote) return null

    const use = shouldUseSfpmVenue({
      inPoolAmountOut,
      sfpmAmountOut: quote.amountOut,
      minSavingsBps,
    })
    botLog(
      `[sfpm-venue] sell ${sellToken0 ? 'token0' : 'token1'} in=${swapAmount} ` +
        `5bpsOut=${quote.amountOut} inPoolOut=${inPoolAmountOut} minSavingsBps=${minSavingsBps} use=${use}`,
    )
    return {
      use,
      sellToken0,
      swapAmount,
      amountOut: quote.amountOut,
      swapPoolTick: quote.swapPoolTick,
    }
  }

  /**
   * Re-quote a durable exact-input obligation against current pool state. Used
   * after a confirmed dispatch when the original tx2 failed or the bot restarted.
   */
  async function quoteSwap(sellToken0: boolean, amountIn: bigint): Promise<SfpmSwapQuote | null> {
    try {
      const slot0 = await publicClient.readContract({
        address: swapPoolAddress,
        abi: slot0Abi,
        functionName: 'slot0',
      })
      const swapPoolTick = Number(slot0[1])

      // Price the 5bps swap with the v3 QuoterV2 — no Safe balance needed (the
      // SFPM-multicall simulation would revert since collateral is CT-locked).
      const [tokenIn, tokenOut] = sellToken0 ? [swapToken0, swapToken1] : [swapToken1, swapToken0]
      const quote = await quoteV3ExactIn({
        client: asSdkClient<typeof quoteV3ExactIn>(publicClient),
        chainId,
        tokenIn,
        tokenOut,
        fee: swapFee,
        amountIn,
        slippageBps,
      })
      if (!quote) {
        botLog('[sfpm-venue] decline: 5bps QuoterV2 returned no quote (pool/liquidity)')
        return null
      }

      return { amountOut: quote.amountOut, swapPoolTick }
    } catch (error) {
      botLog(`[sfpm-venue] decline: quote/read threw — ${String(error).slice(0, 200)}`)
      return null
    }
  }

  return { evaluate, quoteSwap }
}
