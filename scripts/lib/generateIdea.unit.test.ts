import { describe, expect, it } from 'vitest'

import {
  type IdeaChunk,
  aggregateChunks,
  buildDepositMintSafeBatch,
  buildIdeaTokenId,
  formatTradeUrl,
  numeraireIndex,
  rankChunksByMultiplier,
} from './generateIdea'

const WAD = 10n ** 18n

function chunk(
  overrides: Partial<IdeaChunk> & { multiplierWad: bigint; tokenType: bigint },
): IdeaChunk {
  return {
    strike: 0n,
    width: 2n,
    tickLower: -60n,
    tickUpper: 60n,
    netLiquidity: 1_000n,
    removedLiquidity: 0n,
    ...overrides,
  }
}

function row(o: {
  tokenType: string
  tickLower: string
  tickUpper: string
  net: string
  long?: string
  strike?: string
  width?: string
}) {
  return {
    strike: o.strike ?? '0',
    width: o.width ?? '2',
    tickLower: o.tickLower,
    tickUpper: o.tickUpper,
    tokenType: o.tokenType,
    netLiquidity: o.net,
    longLiquidity: o.long ?? '0',
    totalLiquidity: o.net,
  }
}

describe('aggregateChunks', () => {
  it('sums per-owner rows into one pool chunk per (tokenType, ticks)', () => {
    const chunks = aggregateChunks(
      [
        row({ tokenType: '1', tickLower: '-60', tickUpper: '60', net: '1000', long: '100' }),
        row({ tokenType: '1', tickLower: '-60', tickUpper: '60', net: '500', long: '50' }),
        row({ tokenType: '0', tickLower: '-60', tickUpper: '60', net: '200', long: '0' }),
      ],
      4n,
    )
    const call = chunks.find((c) => c.tokenType === 1n)
    expect(call?.netLiquidity).toBe(1_500n)
    expect(call?.removedLiquidity).toBe(150n)
    // spread = 1 + (1/4)*150/1500 = 1.025 → 1.025e18
    expect(call?.multiplierWad).toBe(WAD + (WAD * 150n) / (4n * 1_500n))
    expect(chunks.find((c) => c.tokenType === 0n)?.netLiquidity).toBe(200n)
  })
})

describe('rankChunksByMultiplier', () => {
  const chunks = [
    chunk({ tokenType: 1n, strike: 100n, multiplierWad: WAD + 5n }),
    chunk({ tokenType: 1n, strike: 200n, multiplierWad: WAD + 30n }),
    chunk({ tokenType: 1n, strike: 300n, multiplierWad: WAD + 1n }),
    chunk({ tokenType: 0n, strike: 400n, multiplierWad: WAD + 99n }), // wrong side
  ]

  it('short convexity ranks high multiplier first (best for selling)', () => {
    const ranked = rankChunksByMultiplier(chunks, { convexity: 'short', assetIndex: 1n })
    expect(ranked.map((r) => r.strike)).toEqual([200n, 100n, 300n])
  })

  it('long convexity ranks low multiplier first (best for buying)', () => {
    const ranked = rankChunksByMultiplier(chunks, { convexity: 'long', assetIndex: 1n })
    expect(ranked.map((r) => r.strike)).toEqual([300n, 100n, 200n])
  })

  it('keeps only the call side (tokenType === assetIndex) with net liquidity', () => {
    const withEmpty = [
      ...chunks,
      chunk({ tokenType: 1n, strike: 500n, netLiquidity: 0n, multiplierWad: WAD }),
    ]
    const ranked = rankChunksByMultiplier(withEmpty, { convexity: 'short', assetIndex: 1n })
    expect(ranked.map((r) => r.strike)).not.toContain(400n) // wrong tokenType
    expect(ranked.map((r) => r.strike)).not.toContain(500n) // no liquidity
  })
})

describe('buildIdeaTokenId', () => {
  it('encodes a long call as isLong, a short call as not', () => {
    const long = buildIdeaTokenId({
      poolId: 123n,
      strike: 0n,
      width: 2n,
      convexity: 'long',
      assetIndex: 0n,
    })
    const short = buildIdeaTokenId({
      poolId: 123n,
      strike: 0n,
      width: 2n,
      convexity: 'short',
      assetIndex: 0n,
    })
    expect(long).not.toBe(short)
    expect(typeof long).toBe('bigint')
  })
})

describe('numeraireIndex', () => {
  it('is the token that is NOT the option-sizing asset', () => {
    expect(numeraireIndex(0n)).toBe(1n)
    expect(numeraireIndex(1n)).toBe(0n)
  })
})

describe('buildDepositMintSafeBatch', () => {
  it('emits deposit BEFORE mint, with the right targets', () => {
    const batch = buildDepositMintSafeBatch({
      chainId: 1,
      safeAddress: '0x1111111111111111111111111111111111111111',
      collateralTracker: '0x2222222222222222222222222222222222222222',
      numeraireSymbol: 'USDC',
      numeraireDecimals: 6n,
      poolAddress: '0x3333333333333333333333333333333333333333',
      existingPositionIds: [],
      tokenId: 42n,
      positionSize: 1_000n,
      depositAmount: 5_000_000n,
    })
    expect(batch.calls).toHaveLength(2)
    expect(batch.calls[0].to).toBe('0x2222222222222222222222222222222222222222')
    expect(batch.calls[0].data.startsWith('0x')).toBe(true)
    expect(batch.calls[1].to).toBe('0x3333333333333333333333333333333333333333')
    expect(batch.calls[0].description.toLowerCase()).toContain('deposit')
    expect(batch.calls[1].description.toLowerCase()).toContain('mint')
  })
})

describe('formatTradeUrl', () => {
  it('builds an app.panoptic.xyz/trade URL from the tokenId hex', () => {
    expect(formatTradeUrl(42n)).toMatch(/^https:\/\/app\.panoptic\.xyz\/trade\/0x[0-9a-f]+$/i)
  })
})
