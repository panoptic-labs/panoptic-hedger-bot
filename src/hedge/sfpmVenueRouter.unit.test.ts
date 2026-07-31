import type { Address } from 'viem'
import { describe, expect, it } from 'vitest'

import type { HedgeIntent } from '../executor/types'
import { buildSwapPoolMapping, isSfpmVenueEligible } from './sfpmVenueRouter'

const USDC = '0xA0b86991c6218b36c1d19D4a2e9Eb0cE3606eB48' as Address
const WETH = '0xC02aaA39b223FE8D0A0e5C4F27eAD9083C756Cc2' as Address
const NATIVE = '0x0000000000000000000000000000000000000000' as Address
const POOL_ID = 0xa0488e6a0c2ddn

// Options pool (v4): tokenType0 = native ETH, tokenType1 = USDC.
// Swap pool (v3): token0 = USDC, token1 = WETH.  ← flipped ordering.
const mapping = buildSwapPoolMapping({
  optionsAsset0: NATIVE,
  optionsAsset1: USDC,
  swapToken0: USDC,
  swapToken1: WETH,
  weth9: WETH,
})

/** Single-leg loan tokenId with the given tokenType (bit 64+9). */
function loanTokenId(tokenType: 0 | 1): bigint {
  let id = POOL_ID
  id |= 1n << (64n + 1n) // optionRatio = 1
  id |= BigInt(tokenType) << (64n + 9n)
  return id
}

function intent(overrides: Partial<HedgeIntent>): HedgeIntent {
  return {
    action: 'open',
    openTokenId: loanTokenId(0),
    openPositionSize: 1_000n,
    swapAtMint: true,
    closeTokenIds: [],
    existingPositionIds: [],
    skippedCollidingTokenIds: [],
    currentTick: 201042n,
    slippageBps: 50n,
    ...overrides,
  }
}

describe('buildSwapPoolMapping', () => {
  it('maps native-ETH collateral to WETH and respects flipped ordering', () => {
    // Panoptic tokenType0 (native ETH) → WETH → v3 token1
    expect(mapping.tokenTypeToSwapIndex[0]).toBe(1)
    // Panoptic tokenType1 (USDC) → v3 token0
    expect(mapping.tokenTypeToSwapIndex[1]).toBe(0)
  })

  it('throws when a collateral asset is not in the swap pool', () => {
    expect(() =>
      buildSwapPoolMapping({
        optionsAsset0: '0xdead000000000000000000000000000000000000' as Address,
        optionsAsset1: USDC,
        swapToken0: USDC,
        swapToken1: WETH,
        weth9: WETH,
      }),
    ).toThrow()
  })
})

describe('isSfpmVenueEligible', () => {
  it('is eligible for every swapping action — OPEN/GROW/SHRINK/FLIP/CONSOLIDATE/CLOSE', () => {
    for (const action of ['open', 'grow', 'shrink', 'flip', 'consolidate', 'close_all'] as const) {
      // shrink/flip/close also burn — still eligible (net swap sized by the coordinator)
      const closeTokenIds = action === 'open' || action === 'grow' ? [] : [42n]
      expect(isSfpmVenueEligible(intent({ action, closeTokenIds }), { enabled: true })).toBe(true)
    }
  })

  it('is eligible for a burn-only swapping intent (no mint)', () => {
    expect(
      isSfpmVenueEligible(
        intent({
          action: 'close_all',
          openTokenId: null,
          openPositionSize: null,
          closeTokenIds: [1n],
        }),
        { enabled: true },
      ),
    ).toBe(true)
  })

  it('stays in-pool when disabled', () => {
    expect(isSfpmVenueEligible(intent({}), { enabled: false })).toBe(false)
  })

  it('stays in-pool for state-preserving (swapAtMint=false) intents', () => {
    expect(isSfpmVenueEligible(intent({ swapAtMint: false }), { enabled: true })).toBe(false)
  })

  it('stays in-pool for action=none', () => {
    expect(isSfpmVenueEligible(intent({ action: 'none' }), { enabled: true })).toBe(false)
  })

  it('stays in-pool when there is nothing to do (no mint, no burns)', () => {
    expect(
      isSfpmVenueEligible(
        intent({ openTokenId: null, openPositionSize: null, closeTokenIds: [] }),
        { enabled: true },
      ),
    ).toBe(false)
  })
})
