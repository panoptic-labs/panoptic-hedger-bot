import { describe, expect, it, vi } from 'vitest'

import { readSafeLpPositions } from './lpPositions'

/**
 * These tests are anchored to REAL mainnet LP-subgraph data (Goldsky
 * panoptic-subgraph-lp-mainnet, block ~25,592,219). The Panoptic pool we hedge
 * on mainnet (0x…563b) is a Uniswap v4 native-ETH/USDC pool, so its canonical
 * pair is:
 *   token0 = 0x0000…0000 (native ETH sentinel, as the subgraph encodes it)
 *   token1 = 0xA0b8…eB48 (USDC)
 * The subgraph indexes EVERY Uniswap position, so readSafeLpPositions must keep
 * only same-pair positions and drop everything else.
 */

const ETH = '0x0000000000000000000000000000000000000000'
const USDC = '0xa0b86991c6218b36c1d19d4a2e9eb0ce3606eb48'
const WBTC = '0x2260fac5e5542a773aa44fbcfedf7c193bc2c599'

// A real open ETH/USDC v4 position (subgraph id v4-71998).
const ETH_USDC_POS_A = {
  liquidity: '3290742375047007364',
  tickLower: '-193320',
  tickUpper: '-191100',
  pool: { token0: { id: ETH }, token1: { id: USDC } },
}
// A second real open ETH/USDC v4 position (subgraph id v4-307579).
const ETH_USDC_POS_B = {
  liquidity: '1262822261801522134',
  tickLower: '-203160',
  tickUpper: '-200820',
  pool: { token0: { id: ETH }, token1: { id: USDC } },
}
// A real WBTC/USDC position — right numeraire, wrong pair; must be dropped.
const WBTC_USDC_POS = {
  liquidity: '203336416',
  tickLower: '68040',
  tickUpper: '72120',
  pool: { token0: { id: WBTC }, token1: { id: USDC } },
}

const HEAD_BLOCK = 25_592_219

/** Build a fetch stub that maps each owner id → their lpPositions array. */
function subgraphStub(
  byOwner: Record<string, unknown[]>,
  opts: { headBlock?: number | null; ok?: boolean; errors?: boolean } = {},
): typeof fetch {
  return vi.fn(async (_url: string | URL | Request, init?: RequestInit) => {
    const body = JSON.parse(String(init?.body))
    const owner = String(body.variables.a).toLowerCase()
    const payload = opts.errors
      ? { errors: [{ message: 'boom' }] }
      : {
          data: {
            _meta:
              opts.headBlock === null ? null : { block: { number: opts.headBlock ?? HEAD_BLOCK } },
            account: byOwner[owner] ? { lpPositions: byOwner[owner] } : null,
          },
        }
    return {
      ok: opts.ok ?? true,
      json: async () => payload,
    } as Response
  }) as unknown as typeof fetch
}

const SAFE = '0x2303c6381a65ac2a278511dac15ec2956f78b023'
const LP_OWNER = '0x5ffcdb28b8cc958afe052947d43cb6af04833c37'

describe('readSafeLpPositions', () => {
  it('keeps only same-pair positions and drops other pairs', async () => {
    const fetcher = subgraphStub({
      [SAFE]: [ETH_USDC_POS_A, WBTC_USDC_POS],
    })
    const result = await readSafeLpPositions({
      url: 'http://subgraph',
      owners: [SAFE as `0x${string}`],
      token0: ETH as `0x${string}`,
      token1: USDC as `0x${string}`,
      fetcher,
    })
    expect(result.ok).toBe(true)
    expect(result.headBlock).toBe(BigInt(HEAD_BLOCK))
    expect(result.positions).toEqual([
      { liquidity: 3290742375047007364n, tickLower: -193320n, tickUpper: -191100n },
    ])
  })

  it('matches the pair regardless of address casing', async () => {
    const fetcher = subgraphStub({ [SAFE]: [ETH_USDC_POS_A] })
    const result = await readSafeLpPositions({
      url: 'http://subgraph',
      owners: [SAFE as `0x${string}`],
      // Callers pass checksummed/mixed-case addresses from pool.poolKey.
      token0: ETH as `0x${string}`,
      token1: '0xA0b86991c6218b36c1d19D4a2e9Eb0cE3606eB48' as `0x${string}`, // public USDC address, gitleaks:allow
      fetcher,
    })
    expect(result.ok).toBe(true)
    expect(result.positions).toHaveLength(1)
  })

  it('aggregates across multiple owners (Safe + configured LP owner)', async () => {
    const fetcher = subgraphStub({
      [SAFE]: [ETH_USDC_POS_A],
      [LP_OWNER]: [ETH_USDC_POS_B, WBTC_USDC_POS],
    })
    const result = await readSafeLpPositions({
      url: 'http://subgraph',
      owners: [SAFE as `0x${string}`, LP_OWNER as `0x${string}`],
      token0: ETH as `0x${string}`,
      token1: USDC as `0x${string}`,
      fetcher,
    })
    expect(result.ok).toBe(true)
    expect(result.positions).toEqual([
      { liquidity: 3290742375047007364n, tickLower: -193320n, tickUpper: -191100n },
      { liquidity: 1262822261801522134n, tickLower: -203160n, tickUpper: -200820n },
    ])
    expect(fetcher).toHaveBeenCalledTimes(2)
  })

  it('dedupes repeated owners so positions are never double-counted', async () => {
    const fetcher = subgraphStub({ [SAFE]: [ETH_USDC_POS_A] })
    const result = await readSafeLpPositions({
      url: 'http://subgraph',
      // Same owner twice (e.g. UNISWAP_LP_OWNER pointed at the Safe), and with
      // differing case — must collapse to a single scan.
      owners: [SAFE as `0x${string}`, SAFE.toUpperCase() as `0x${string}`],
      token0: ETH as `0x${string}`,
      token1: USDC as `0x${string}`,
      fetcher,
    })
    expect(result.ok).toBe(true)
    expect(result.positions).toEqual([
      { liquidity: 3290742375047007364n, tickLower: -193320n, tickUpper: -191100n },
    ])
    expect(fetcher).toHaveBeenCalledTimes(1)
  })

  it('skips non-positive liquidity (closed/dust positions)', async () => {
    const fetcher = subgraphStub({
      [SAFE]: [{ ...ETH_USDC_POS_A, liquidity: '0' }, ETH_USDC_POS_B],
    })
    const result = await readSafeLpPositions({
      url: 'http://subgraph',
      owners: [SAFE as `0x${string}`],
      token0: ETH as `0x${string}`,
      token1: USDC as `0x${string}`,
      fetcher,
    })
    expect(result.positions).toEqual([
      { liquidity: 1262822261801522134n, tickLower: -203160n, tickUpper: -200820n },
    ])
  })

  it('returns an empty (ok) result when an owner has no account node', async () => {
    const fetcher = subgraphStub({}) // account: null for every owner
    const result = await readSafeLpPositions({
      url: 'http://subgraph',
      owners: [SAFE as `0x${string}`],
      token0: ETH as `0x${string}`,
      token1: USDC as `0x${string}`,
      fetcher,
    })
    expect(result.ok).toBe(true)
    expect(result.positions).toEqual([])
    expect(result.headBlock).toBe(BigInt(HEAD_BLOCK))
  })

  it('reports ok:false on a non-2xx response (never throws into the cycle)', async () => {
    const fetcher = subgraphStub({ [SAFE]: [ETH_USDC_POS_A] }, { ok: false })
    const result = await readSafeLpPositions({
      url: 'http://subgraph',
      owners: [SAFE as `0x${string}`],
      token0: ETH as `0x${string}`,
      token1: USDC as `0x${string}`,
      fetcher,
    })
    expect(result.ok).toBe(false)
    expect(result.positions).toEqual([])
    expect(result.headBlock).toBe(0n)
  })

  it('reports ok:false on GraphQL errors', async () => {
    const fetcher = subgraphStub({ [SAFE]: [ETH_USDC_POS_A] }, { errors: true })
    const result = await readSafeLpPositions({
      url: 'http://subgraph',
      owners: [SAFE as `0x${string}`],
      token0: ETH as `0x${string}`,
      token1: USDC as `0x${string}`,
      fetcher,
    })
    expect(result.ok).toBe(false)
    expect(result.positions).toEqual([])
  })

  it('reports ok:false when the fetch itself throws', async () => {
    const fetcher = vi.fn(async () => {
      throw new Error('network down')
    }) as unknown as typeof fetch
    const result = await readSafeLpPositions({
      url: 'http://subgraph',
      owners: [SAFE as `0x${string}`],
      token0: ETH as `0x${string}`,
      token1: USDC as `0x${string}`,
      fetcher,
    })
    expect(result.ok).toBe(false)
    expect(result.positions).toEqual([])
  })
})
