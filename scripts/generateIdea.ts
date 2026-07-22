import 'dotenv/config'

import { fileURLToPath } from 'node:url'

import { getAccountBuyingPower, getChainDeployment, getPool } from '@panoptic-eng/sdk/v2'
import { type Address, type PublicClient, createPublicClient, formatUnits, http } from 'viem'

import { parseHedgerBotConfig } from '../src/config'
import { defineBotChain } from '../src/utils/chain'
import { sanitizeError } from '../src/utils/sanitize'
import { asSdkClient } from '../src/utils/sdkClient'
import {
  type Convexity,
  type RankedIdea,
  buildDepositMintSafeBatch,
  buildRankedIdeas,
  fetchPoolChunks,
  formatMultiplier,
  formatTradeUrl,
  numeraireIndex,
} from './lib/generateIdea'
import { Prompter } from './lib/prompts'
import { emitSafeTransactionBuilderBatch } from './lib/safeProposal'

/**
 * `pnpm generate:idea` — an interactive helper that proposes a first position
 * for a freshly-onboarded Safe. Reads only; emits either a trade URL + manual
 * instructions or an importable Safe Transaction Builder batch (deposit + mint).
 * It never sends a transaction.
 *
 * Also reusable from the onboard wizard via `runGenerateIdea(p, ctx)` so the
 * already-open Prompter and resolved config are shared.
 */

export interface GenerateIdeaContext {
  client: PublicClient
  chainId: number
  poolAddress: Address
  safeAddress: Address
  /** Option-sizing (non-numeraire) token index. */
  assetIndex: bigint
  /** Panoptic subgraph GraphQL endpoint (chunk source). */
  subgraphUrl: string
  /** PanopticQuery address (collateral-requirement estimate). */
  queryAddress: Address
}

/** How many finalists to size + present. */
const FINALIST_LIMIT = 5

export async function runGenerateIdea(p: Prompter, ctx: GenerateIdeaContext): Promise<void> {
  const pool = await getPool({
    client: asSdkClient<typeof getPool>(ctx.client),
    poolAddress: ctx.poolAddress,
    chainId: BigInt(ctx.chainId),
  })
  const m = pool.metadata
  const assetSymbol = ctx.assetIndex === 0n ? m.token0Symbol : m.token1Symbol
  const numeraire = numeraireIndex(ctx.assetIndex)
  const numeraireSymbol = numeraire === 0n ? m.token0Symbol : m.token1Symbol
  const numeraireDecimals = Number(
    (numeraire === 0n ? pool.collateralTracker0 : pool.collateralTracker1).decimals,
  )
  const assetDecimals = Number(
    (ctx.assetIndex === 0n ? pool.collateralTracker0 : pool.collateralTracker1).decimals,
  )
  const tokenSymbol = (i: bigint) => (i === 0n ? m.token0Symbol : m.token1Symbol)
  const collateralTrackerFor = (i: bigint) =>
    i === 0n ? pool.collateralTracker0 : pool.collateralTracker1

  // Humanized price at a strike tick, expressed as numeraire per asset.
  const dec0 = Number(pool.collateralTracker0.decimals)
  const dec1 = Number(pool.collateralTracker1.decimals)
  const priceNumPerAsset = (tick: bigint): number => {
    const token1PerToken0 = Math.pow(1.0001, Number(tick)) * Math.pow(10, dec0 - dec1)
    return numeraire === 1n ? token1PerToken0 : 1 / token1PerToken0
  }
  const fmtPrice = (tick: bigint) => priceNumPerAsset(tick).toPrecision(6)
  const fmtDeposit = (idea: RankedIdea) =>
    `${formatUnits(idea.depositAmount, Number(collateralTrackerFor(idea.depositTokenIndex).decimals))} ${tokenSymbol(idea.depositTokenIndex)}`

  const convexity = await p.choice<Convexity>(
    'Position convexity',
    [
      {
        label: 'Long convexity — BUY options (pay premium; unlimited upside, capped downside)',
        value: 'long',
      },
      {
        label:
          'Short convexity — SELL options (collect premium; capped upside, unlimited downside)',
        value: 'short',
      },
    ],
    'long',
  )

  // Current collateral + free buying power for the Safe (no positions assumed).
  const bp = await getAccountBuyingPower({
    client: asSdkClient<typeof getAccountBuyingPower>(ctx.client),
    poolAddress: ctx.poolAddress,
    account: ctx.safeAddress,
    tokenIds: [],
  })
  const free = (bal: bigint, req: bigint) => (bal > req ? bal - req : 0n)
  const freeNum =
    numeraire === 0n
      ? free(bp.collateralBalance0, bp.requiredCollateral0)
      : free(bp.collateralBalance1, bp.requiredCollateral1)
  console.log(
    `\n Safe ${ctx.safeAddress} collateral:\n` +
      `   ${formatUnits(bp.collateralBalance0, dec0)} ${m.token0Symbol}, ` +
      `${formatUnits(bp.collateralBalance1, dec1)} ${m.token1Symbol}\n` +
      `   free buying power: ${formatUnits(freeNum, numeraireDecimals)} ${numeraireSymbol}`,
  )

  const moreRaw = await p.text(
    `Deposit more ${numeraireSymbol}? (blank/0 = size the position at ~10% of current buying power)`,
    {
      default: '0',
      validate: (v) =>
        Number(v) >= 0 && Number.isFinite(Number(v)) ? undefined : 'enter a non-negative number',
    },
  )
  // Keep the amount as a decimal string end-to-end (parsed straight to the
  // token's smallest unit) — never route the deposit size through a JS float.
  let usdAmount: string
  if (Number(moreRaw) > 0) {
    usdAmount = moreRaw.trim()
  } else {
    if (freeNum <= 0n) {
      console.log(
        '  No free buying power and no additional deposit — deposit some collateral first.',
      )
      return
    }
    usdAmount = formatUnits(freeNum / 10n, numeraireDecimals)
    console.log(`  → sizing at ~10% of buying power: ${usdAmount} ${numeraireSymbol}`)
  }

  // Real chunks come from the subgraph (all widths), not a fixed-width on-chain
  // grid scan (which would miss positions at non-unit widths).
  console.log(`\n Fetching ${assetSymbol} call chunks from the subgraph…`)
  const chunks = await fetchPoolChunks({
    subgraphUrl: ctx.subgraphUrl,
    poolAddress: ctx.poolAddress,
    vegoid: pool.riskEngine.vegoid,
  })
  const callChunks = chunks.filter((c) => c.tokenType === ctx.assetIndex)
  if (callChunks.length === 0) {
    console.log(
      `  No ${assetSymbol} call chunks with liquidity found for this pool — ` +
        'nothing to base a first position on yet.',
    )
    return
  }

  const ideas = await buildRankedIdeas({
    client: ctx.client,
    pool,
    account: ctx.safeAddress,
    queryAddress: ctx.queryAddress,
    convexity,
    assetIndex: ctx.assetIndex,
    usdAmount,
    chunks,
    limit: FINALIST_LIMIT,
  })
  if (ideas.length === 0) {
    console.log(
      '  Could not estimate a collateral requirement for any candidate chunk — the pool may ' +
        'have no usable call chunks right now.',
    )
    return
  }

  const priceLabel = `price (${numeraireSymbol}/${assetSymbol})`
  const sizeLabel = `positionSize (${assetSymbol})`
  console.log(
    `\n Ranked candidates (${convexity === 'short' ? 'high' : 'low'} spread multiplier first — ` +
      `best for ${convexity === 'short' ? 'selling' : 'buying'}).\n`,
  )
  const col = { idx: 3, strike: 11, price: 18, spread: 18, size: 26 }
  const pad = (s: string, w: number) => s.padEnd(w)
  const padL = (s: string, w: number) => s.padStart(w)
  const fmtSize = (idea: RankedIdea) =>
    `${formatUnits(idea.positionSize, assetDecimals)} ${assetSymbol}`
  console.log(
    '  ' +
      pad('#', col.idx) +
      padL('strike', col.strike) +
      padL(priceLabel, col.price) +
      padL('spread multiplier', col.spread) +
      padL(sizeLabel, col.size),
  )
  console.log('  ' + '-'.repeat(col.idx + col.strike + col.price + col.spread + col.size))
  ideas.forEach((idea, i) => {
    console.log(
      '  ' +
        pad(`${i + 1}`, col.idx) +
        padL(`${idea.chunk.strike}`, col.strike) +
        padL(fmtPrice(idea.chunk.strike), col.price) +
        padL(formatMultiplier(idea.multiplierWad), col.spread) +
        padL(fmtSize(idea), col.size),
    )
  })

  const pick = await p.choice(
    'Choose a candidate',
    ideas.map((idea, i) => ({
      label: `#${i + 1} strike ${idea.chunk.strike} | ${fmtPrice(idea.chunk.strike)} ${numeraireSymbol}/${assetSymbol}`,
      value: String(i),
    })),
    '0',
  )
  const chosen = ideas[Number(pick)]

  const output = await p.choice(
    'Output',
    [
      { label: 'Trade URL + manual deposit/mint instructions', value: 'url' },
      { label: 'Safe Transaction Builder JSON (batches deposit + mint)', value: 'safe' },
    ],
    'url',
  )

  const depositCt = collateralTrackerFor(chosen.depositTokenIndex)
  if (output === 'url') {
    console.log('\n──────── First-position idea ────────')
    console.log(`  Trade URL: ${formatTradeUrl(chosen.tokenId)}`)
    console.log(
      `  In the app: deposit ~${fmtDeposit(chosen)} of collateral, then open with ` +
        `positionSize ${chosen.positionSize}.`,
    )
    console.log('─────────────────────────────────────\n')
    return
  }

  emitSafeTransactionBuilderBatch(
    buildDepositMintSafeBatch({
      chainId: ctx.chainId,
      safeAddress: ctx.safeAddress,
      collateralTracker: depositCt.address,
      numeraireSymbol: tokenSymbol(chosen.depositTokenIndex),
      numeraireDecimals: depositCt.decimals,
      poolAddress: ctx.poolAddress,
      existingPositionIds: [],
      tokenId: chosen.tokenId,
      positionSize: chosen.positionSize,
      depositAmount: chosen.depositAmount,
    }),
  )
}

/** Resolve a context from the bot's `.env` (standalone entrypoint). */
export function contextFromEnv(): GenerateIdeaContext {
  const config = parseHedgerBotConfig()
  const chain = defineBotChain(config.CHAIN_ID, config.RPC_URL)
  const client = createPublicClient({ chain, transport: http(config.RPC_URL) }) as PublicClient
  const deployment = getChainDeployment(config.CHAIN_ID)
  const subgraphUrl = deployment?.subgraphs.panoptic
  const queryAddress = deployment?.panoptic.v2.panopticQuery
  if (!subgraphUrl) {
    throw new Error(
      `no Panoptic subgraph URL for chain ${config.CHAIN_ID}; the idea generator needs it to list chunks`,
    )
  }
  if (!queryAddress) {
    throw new Error(
      `no PanopticQuery address for chain ${config.CHAIN_ID}; the idea generator needs it to estimate collateral`,
    )
  }
  return {
    client,
    chainId: config.CHAIN_ID,
    poolAddress: config.POOL_ADDRESS,
    safeAddress: config.SAFE_ADDRESS,
    assetIndex: config.ASSET_INDEX,
    subgraphUrl,
    queryAddress,
  }
}

async function main(): Promise<void> {
  const p = new Prompter()
  try {
    await runGenerateIdea(p, contextFromEnv())
  } finally {
    p.close()
  }
}

const entrypoint = process.argv[1]
if (entrypoint && fileURLToPath(import.meta.url) === entrypoint) {
  main().catch((err) => {
    console.error(sanitizeError(err))
    process.exit(1)
  })
}
