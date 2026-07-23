import type { Address } from 'viem'
import { z } from 'zod'

/**
 * Read the operator's plain Uniswap v3/v4 LP positions from the LP subgraph, for
 * folding into the hedge delta. Only positions on the SAME token pair as the
 * Panoptic pool are returned (canonical token ordering ⇒ exact address match),
 * priced later at the pool's current tick by the caller.
 *
 * This never throws into the hedge cycle: any network/parse failure yields
 * `ok: false` (LP delta is additive and must never block a hedge). The caller
 * applies a freshness guard using `headBlock` vs the chain head.
 */

export interface LpPositionForHedge {
  liquidity: bigint
  tickLower: bigint
  tickUpper: bigint
}

export interface ReadSafeLpPositionsResult {
  positions: LpPositionForHedge[]
  /** LP subgraph indexed head block (0n when unavailable). */
  headBlock: bigint
  /** False when the query failed or returned malformed data. */
  ok: boolean
}

export interface ReadSafeLpPositionsDeps {
  url: string
  /** Addresses to scan (e.g. the Safe and an optional configured LP owner). */
  owners: Address[]
  /** Panoptic pool's underlying token pair (canonical ordering). */
  token0: Address
  token1: Address
  fetcher?: typeof fetch
}

const responseSchema = z.object({
  data: z
    .object({
      _meta: z.object({ block: z.object({ number: z.number().int().nonnegative() }) }).nullable(),
      account: z
        .object({
          lpPositions: z.array(
            z.object({
              liquidity: z.string(),
              tickLower: z.string(),
              tickUpper: z.string(),
              pool: z.object({
                token0: z.object({ id: z.string() }),
                token1: z.object({ id: z.string() }),
              }),
            }),
          ),
        })
        .nullable(),
    })
    .optional(),
  errors: z.array(z.object({ message: z.string() })).optional(),
})

const QUERY = `query HedgerLpPositions($a: ID!) {
  _meta { block { number } }
  account(id: $a) {
    lpPositions(first: 1000, where: { isOpen: 1 }) {
      liquidity
      tickLower
      tickUpper
      pool { token0 { id } token1 { id } }
    }
  }
}`

export async function readSafeLpPositions(
  deps: ReadSafeLpPositionsDeps,
): Promise<ReadSafeLpPositionsResult> {
  const fetcher = deps.fetcher ?? fetch
  const token0 = deps.token0.toLowerCase()
  const token1 = deps.token1.toLowerCase()

  // Dedupe owners (case-insensitive): callers append UNISWAP_LP_OWNER to the
  // Safe, so an owner pointed at the Safe — or any repeat — would otherwise be
  // scanned twice and its positions double-counted.
  const owners = [...new Set(deps.owners.map((o) => o.toLowerCase()))]

  // One filtered-position batch per owner, plus the subgraph head it was read
  // at. `ok: false` propagates a bad HTTP status / GraphQL error for that owner.
  type OwnerResult = { ok: boolean; block?: bigint; positions: LpPositionForHedge[] }

  try {
    // Issue every owner query concurrently: total latency is the slowest
    // request, not the sum. Results are aggregated in `owners` order below so
    // headBlock handling matches the previous sequential (last-owner-wins) code.
    const perOwner = await Promise.all(
      owners.map(async (owner): Promise<OwnerResult> => {
        const response = await fetcher(deps.url, {
          method: 'POST',
          headers: { 'content-type': 'application/json' },
          body: JSON.stringify({ query: QUERY, variables: { a: owner } }),
          signal: AbortSignal.timeout(12_000),
        })
        if (!response.ok) return { ok: false, positions: [] }
        const body = responseSchema.parse(await response.json())
        if (body.errors?.length) return { ok: false, positions: [] }

        const block = body.data?._meta?.block.number
        const positions: LpPositionForHedge[] = []
        for (const p of body.data?.account?.lpPositions ?? []) {
          if (p.pool.token0.id.toLowerCase() !== token0) continue
          if (p.pool.token1.id.toLowerCase() !== token1) continue
          const liquidity = BigInt(p.liquidity)
          if (liquidity <= 0n) continue
          positions.push({
            liquidity,
            tickLower: BigInt(p.tickLower),
            tickUpper: BigInt(p.tickUpper),
          })
        }
        return { ok: true, block: block === undefined ? undefined : BigInt(block), positions }
      }),
    )

    if (perOwner.some((r) => !r.ok)) return { positions: [], headBlock: 0n, ok: false }

    const positions: LpPositionForHedge[] = []
    let headBlock = 0n
    for (const r of perOwner) {
      positions.push(...r.positions)
      if (r.block !== undefined) headBlock = r.block
    }
    return { positions, headBlock, ok: true }
  } catch {
    return { positions: [], headBlock: 0n, ok: false }
  }
}
