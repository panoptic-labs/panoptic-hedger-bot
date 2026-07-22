import {
  type Pool,
  buildOpenPositionCalldata,
  calculatePositionGreeks,
  calculateSpreadWad,
  collateralTrackerV2Abi,
  createTokenIdBuilder,
  decodeTokenId,
  estimateCollateralRequired,
  formatTokenIdHex,
} from '@panoptic-eng/sdk/v2'
import type { Address, Hex, PublicClient } from 'viem'
import { encodeFunctionData, formatUnits, parseUnits } from 'viem'

import { MAX_TICK, MIN_TICK } from '../../src/constants/ticks'
import { asSdkClient } from '../../src/utils/sdkClient'
import type { SafeProposalCall } from './safeProposal'

/**
 * "Generate first-position idea" core (chunk fetch + pure ranking + calldata
 * assembly). No prompts and no sends here — the CLI driver and the onboard hook
 * both call these. See scripts/generateIdea.ts.
 *
 * Chunks come from the Panoptic subgraph (real, existing chunks at their actual
 * widths), NOT from an on-chain fixed-width grid scan — positions live at many
 * widths, so a single-width scan finds almost nothing.
 *
 * Convexity → position side:
 *   - long  = BUY the option (isLong=true): pay premium, unlimited upside,
 *     capped downside → want a LOW premium multiplier (cheap to buy).
 *   - short = SELL the option (isLong=false): collect premium, capped upside,
 *     unlimited downside → want a HIGH premium multiplier (rich to sell).
 *
 * The premium multiplier is the chunk spread (`calculateSpreadWad`): 1e18 = 1.0x,
 * computed from the chunk's net (available) vs long (removed by buyers) liquidity.
 */

export type Convexity = 'long' | 'short'

const WAD = 10n ** 18n

/** A pool-level liquidity chunk (aggregated across owners) with its multiplier. */
export interface IdeaChunk {
  strike: bigint
  /** Width in tick-spacing units — the tokenId `width` field. */
  width: bigint
  tickLower: bigint
  tickUpper: bigint
  /** 0 = put side, 1 = call side. */
  tokenType: bigint
  /** Net liquidity still in Uniswap (available to buy). */
  netLiquidity: bigint
  /** Long liquidity removed by buyers. */
  removedLiquidity: bigint
  /** Premium multiplier (WAD; 1e18 = 1.0x). */
  multiplierWad: bigint
}

interface SubgraphChunkRow {
  strike: string
  width: string
  tickLower: string
  tickUpper: string
  tokenType: string
  netLiquidity: string
  longLiquidity: string | null
  totalLiquidity: string | null
}

const CHUNKS_QUERY = `query PoolChunks($pool: String!, $first: Int!) {
  chunks(
    first: $first
    orderBy: strike
    orderDirection: asc
    where: { panopticPool: $pool, totalLiquidity_gt: "0" }
  ) {
    strike
    width
    tickLower
    tickUpper
    tokenType
    netLiquidity
    longLiquidity
    totalLiquidity
  }
}`

/**
 * Fetch pool chunks from the Panoptic subgraph and aggregate per
 * (tokenType, tickLower, tickUpper) across owners into pool-level liquidity,
 * attaching the spread multiplier. `fetchImpl` is injectable for tests.
 */
export async function fetchPoolChunks(params: {
  subgraphUrl: string
  poolAddress: Address
  vegoid: bigint
  first?: number
  fetchImpl?: typeof fetch
}): Promise<IdeaChunk[]> {
  const doFetch = params.fetchImpl ?? fetch
  const res = await doFetch(params.subgraphUrl, {
    method: 'POST',
    headers: { 'content-type': 'application/json' },
    body: JSON.stringify({
      query: CHUNKS_QUERY,
      variables: { pool: params.poolAddress.toLowerCase(), first: params.first ?? 1000 },
    }),
  })
  if (!res.ok) throw new Error(`subgraph query failed: HTTP ${res.status}`)
  const json = (await res.json()) as {
    data?: { chunks?: SubgraphChunkRow[] }
    errors?: { message: string }[]
  }
  if (json.errors?.length) throw new Error(`subgraph error: ${json.errors[0].message}`)
  return aggregateChunks(json.data?.chunks ?? [], params.vegoid)
}

/** Sum per-owner rows into pool-level chunks keyed by (tokenType, ticks). */
export function aggregateChunks(rows: SubgraphChunkRow[], vegoid: bigint): IdeaChunk[] {
  const byKey = new Map<string, IdeaChunk>()
  for (const row of rows) {
    const tokenType = BigInt(row.tokenType)
    const tickLower = BigInt(row.tickLower)
    const tickUpper = BigInt(row.tickUpper)
    const key = `${tokenType}:${tickLower}:${tickUpper}`
    const net = BigInt(row.netLiquidity)
    const removed = BigInt(row.longLiquidity ?? '0')
    const existing = byKey.get(key)
    if (existing) {
      existing.netLiquidity += net
      existing.removedLiquidity += removed
    } else {
      byKey.set(key, {
        strike: BigInt(row.strike),
        width: BigInt(row.width),
        tickLower,
        tickUpper,
        tokenType,
        netLiquidity: net,
        removedLiquidity: removed,
        multiplierWad: 0n,
      })
    }
  }
  const chunks = [...byKey.values()]
  for (const c of chunks) {
    c.multiplierWad = calculateSpreadWad(c.netLiquidity, c.removedLiquidity, vegoid)
  }
  return chunks
}

/** A ranked candidate: the chunk plus the size/greeks/amounts solved for it. */
export interface RankedIdea {
  chunk: IdeaChunk
  multiplierWad: bigint
  tokenId: bigint
  positionSize: bigint
  /** Collateral the mint requires, in the deposit token (smallest units). */
  depositAmount: bigint
  /** Which token to deposit (0 or 1). */
  depositTokenIndex: 0n | 1n
  /** Dollar-gamma in numeraire smallest units (client-side greeks). */
  gamma: bigint
}

/**
 * Rank chunks for the chosen convexity: a call on `assetIndex` lives on the
 * tokenType === assetIndex side, so keep only those chunks with net liquidity,
 * then sort by multiplier — descending (high) for `short` (selling), ascending
 * (low) for `long` (buying).
 */
export function rankChunksByMultiplier(
  chunks: IdeaChunk[],
  params: { convexity: Convexity; assetIndex: bigint },
): IdeaChunk[] {
  const ranked = chunks.filter((c) => c.tokenType === params.assetIndex && c.netLiquidity > 0n)
  ranked.sort((a, b) =>
    params.convexity === 'short'
      ? a.multiplierWad > b.multiplierWad
        ? -1
        : a.multiplierWad < b.multiplierWad
          ? 1
          : 0
      : a.multiplierWad < b.multiplierWad
        ? -1
        : a.multiplierWad > b.multiplierWad
          ? 1
          : 0,
  )
  return ranked
}

/** Single-leg call on `assetIndex`; isLong follows convexity. */
export function buildIdeaTokenId(params: {
  poolId: bigint
  strike: bigint
  width: bigint
  convexity: Convexity
  assetIndex: bigint
}): bigint {
  return createTokenIdBuilder(params.poolId)
    .addCall({
      asset: params.assetIndex,
      strike: params.strike,
      width: params.width,
      optionRatio: 1n,
      isLong: params.convexity === 'long',
    })
    .build()
}

/** The numeraire (USD-ish) side is the token that is NOT the option-sizing asset. */
export function numeraireIndex(assetIndex: bigint): 0n | 1n {
  return assetIndex === 0n ? 1n : 0n
}

export interface SizeFromUsdResult {
  positionSize: bigint
  /** Collateral the mint requires, in the deposit token (smallest units). */
  depositAmount: bigint
  /** Which token the deposit/requirement is denominated in (0 or 1). */
  depositTokenIndex: 0n | 1n
  gamma: bigint
}

/** A reasonable reference size to probe the (linear) collateral requirement. */
const REFERENCE_POSITION_SIZE = 10n ** 9n

/**
 * Solve the `positionSize` whose collateral requirement in the deposit token is
 * ~`usdAmount`. The requirement is LINEAR in size (PanopticQuery.getRequiredBase
 * via estimateCollateralRequired) and needs no funded account, so we probe once
 * at a reference size and invert. Prefers the numeraire side; if the requirement
 * there is zero, falls back to the asset side (and reports which to deposit).
 * Returns null if neither side has a positive requirement.
 */
export async function sizeFromUsd(params: {
  client: PublicClient
  poolAddress: Address
  account: Address
  queryAddress: Address
  tokenId: bigint
  /** Deposit target as a decimal string (e.g. "32.5") — parsed directly to the
   * deposit token's smallest unit, never routed through a JS float. */
  usdAmount: string
  assetIndex: bigint
  currentTick: bigint
  poolTickSpacing: bigint
  numeraireDecimals: bigint
  assetDecimals: bigint
}): Promise<SizeFromUsdResult | null> {
  const numeraire = numeraireIndex(params.assetIndex)
  const est = await estimateCollateralRequired({
    client: asSdkClient<typeof estimateCollateralRequired>(params.client),
    poolAddress: params.poolAddress,
    account: params.account,
    queryAddress: params.queryAddress,
    tokenId: params.tokenId,
    positionSize: REFERENCE_POSITION_SIZE,
    atTick: params.currentTick,
  })
  // Choose the deposit side: numeraire first, else the asset side.
  const reqNumeraire = numeraire === 0n ? est.required0 : est.required1
  const [depositTokenIndex, reqAtRef, depositDecimals] =
    reqNumeraire > 0n
      ? ([numeraire, reqNumeraire, params.numeraireDecimals] as const)
      : ([
          params.assetIndex as 0n | 1n,
          numeraire === 0n ? est.required1 : est.required0,
          params.assetDecimals,
        ] as const)
  if (reqAtRef <= 0n) return null

  const target = parseUnits(params.usdAmount, Number(depositDecimals))
  if (target <= 0n) return null

  // Linear invert: positionSize = refSize * target / requirement(refSize).
  const positionSize = (REFERENCE_POSITION_SIZE * target) / reqAtRef
  if (positionSize <= 0n) return null

  const { legs, tickSpacing } = decodeTokenId(params.tokenId)
  const greeks = calculatePositionGreeks({
    legs,
    currentTick: params.currentTick,
    mintTick: params.currentTick,
    positionSize,
    poolTickSpacing: tickSpacing || params.poolTickSpacing,
  })
  return { positionSize, depositAmount: target, depositTokenIndex, gamma: greeks.gamma }
}

/**
 * Refine finalists: solve size + greeks for each of the top-`limit` ranked
 * chunks. Chunks whose collateral requirement can't be estimated are dropped.
 */
export async function buildRankedIdeas(params: {
  client: PublicClient
  pool: Pool
  account: Address
  queryAddress: Address
  convexity: Convexity
  assetIndex: bigint
  /** Deposit target as a decimal string (see {@link sizeFromUsd}). */
  usdAmount: string
  chunks: IdeaChunk[]
  limit?: number
}): Promise<RankedIdea[]> {
  const numeraire = numeraireIndex(params.assetIndex)
  const numeraireDecimals =
    numeraire === 0n
      ? params.pool.collateralTracker0.decimals
      : params.pool.collateralTracker1.decimals
  const assetDecimals =
    params.assetIndex === 0n
      ? params.pool.collateralTracker0.decimals
      : params.pool.collateralTracker1.decimals
  const ranked = rankChunksByMultiplier(params.chunks, {
    convexity: params.convexity,
    assetIndex: params.assetIndex,
  }).slice(0, params.limit ?? 5)

  const ideas: RankedIdea[] = []
  for (const chunk of ranked) {
    const tokenId = buildIdeaTokenId({
      poolId: params.pool.poolId,
      strike: chunk.strike,
      width: chunk.width,
      convexity: params.convexity,
      assetIndex: params.assetIndex,
    })
    const sized = await sizeFromUsd({
      client: params.client,
      poolAddress: params.pool.address,
      account: params.account,
      queryAddress: params.queryAddress,
      tokenId,
      usdAmount: params.usdAmount,
      assetIndex: params.assetIndex,
      currentTick: params.pool.currentTick,
      poolTickSpacing: params.pool.tickSpacing,
      numeraireDecimals,
      assetDecimals,
    })
    if (!sized) continue
    ideas.push({
      chunk,
      multiplierWad: chunk.multiplierWad,
      tokenId,
      positionSize: sized.positionSize,
      depositAmount: sized.depositAmount,
      depositTokenIndex: sized.depositTokenIndex,
      gamma: sized.gamma,
    })
  }
  return ideas
}

/** `app.panoptic.xyz/trade/0x<tokenId>` for the human path. */
export function formatTradeUrl(tokenId: bigint): string {
  return `https://app.panoptic.xyz/trade/${formatTokenIdHex(tokenId)}`
}

/** Human-readable WAD multiplier, e.g. 1.2345x. */
export function formatMultiplier(wad: bigint): string {
  const whole = wad / WAD
  const frac = ((wad % WAD) * 10_000n) / WAD
  return `${whole}.${frac.toString().padStart(4, '0')}x`
}

/**
 * Safe Transaction Builder batch: CollateralTracker.deposit(depositAmount, safe)
 * followed by PanopticPool.dispatch(...) mint. Deposit MUST precede the mint so
 * the collateral is present when the position opens.
 */
export function buildDepositMintSafeBatch(params: {
  chainId: number
  safeAddress: Address
  collateralTracker: Address
  numeraireSymbol: string
  numeraireDecimals: bigint
  poolAddress: Address
  existingPositionIds: bigint[]
  tokenId: bigint
  positionSize: bigint
  depositAmount: bigint
}) {
  const depositData: Hex = encodeFunctionData({
    abi: collateralTrackerV2Abi,
    functionName: 'deposit',
    args: [params.depositAmount, params.safeAddress],
  })
  const mint = buildOpenPositionCalldata({
    poolAddress: params.poolAddress,
    existingPositionIds: params.existingPositionIds,
    tokenId: params.tokenId,
    positionSize: params.positionSize,
    tickLimitLow: BigInt(MIN_TICK),
    tickLimitHigh: BigInt(MAX_TICK),
  })
  const amount = formatUnits(params.depositAmount, Number(params.numeraireDecimals))
  const calls: SafeProposalCall[] = [
    {
      description: `deposit ${amount} ${params.numeraireSymbol} collateral into the pool`,
      to: params.collateralTracker,
      value: 0n,
      data: depositData,
    },
    {
      description: `mint first position ${formatTokenIdHex(params.tokenId)} (size ${params.positionSize})`,
      to: mint.to,
      value: 0n,
      data: mint.data,
    },
  ]
  return {
    chainId: params.chainId,
    safeAddress: params.safeAddress,
    name: 'Open first Panoptic position',
    description: 'Deposit collateral, then mint the chosen first position.',
    calls,
  }
}
