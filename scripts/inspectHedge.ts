import 'dotenv/config'

import { createMemoryStorage } from '@panoptic-eng/sdk/v2'
import { createPublicClient, formatUnits, http } from 'viem'

import { parseHedgerBotConfig } from '../src/config'
import { protocolGenesisBlock } from '../src/constants/genesis'
import { computeHedgePlan } from '../src/hedge/decision'
import { assessSafety } from '../src/hedge/safety'
import { readHedgeSnapshot } from '../src/hedge/snapshot'
import { createPriceSignalSource } from '../src/priceSignal'
import { resolveCexAssetOrientation } from '../src/priceSignal/cexSource'
import { defineBotChain } from '../src/utils/chain'
import { sanitizeError } from '../src/utils/sanitize'

/**
 * Dry-run a single hedge cycle: read state, compute the plan, and print it.
 * Never sends a transaction. Useful for validating config + signal + math.
 *
 *   pnpm inspect:hedge
 */
async function main(): Promise<void> {
  const config = parseHedgerBotConfig()
  const chain = defineBotChain(config.CHAIN_ID, config.RPC_URL)
  const publicClient = createPublicClient({ chain, transport: http(config.RPC_URL) })
  const chainId = BigInt(config.CHAIN_ID)
  const snapshotDeps = {
    publicClient,
    poolAddress: config.POOL_ADDRESS,
    chainId,
    safeAddress: config.SAFE_ADDRESS,
    storage: createMemoryStorage(),
    fromBlock: config.SYNC_FROM_BLOCK ?? protocolGenesisBlock(config.CHAIN_ID),
  }
  let snapshot = await readHedgeSnapshot(snapshotDeps)
  const metadata = snapshot.pool.metadata
  const priceSource = createPriceSignalSource(config, {
    publicClient,
    token0Decimals: BigInt(metadata.token0Decimals),
    token1Decimals: BigInt(metadata.token1Decimals),
    ethTokenIndex:
      config.PRICE_SIGNAL_SOURCE === 'cex'
        ? resolveCexAssetOrientation(config.CHAIN_ID, metadata.token0Asset, metadata.token1Asset)
        : undefined,
  })
  const signal = await (async () => {
    try {
      return await priceSource.getSignal()
    } finally {
      priceSource.stop?.()
    }
  })()
  if (signal.blockNumber !== undefined && signal.blockNumber !== snapshot.blockNumber) {
    snapshot = await readHedgeSnapshot({ ...snapshotDeps, blockNumber: signal.blockNumber })
  }
  console.log('signal:', {
    source: signal.source,
    tick: signal.tick.toString(),
    observedAtMs: signal.observedAtMs,
  })

  console.log(
    `positions: ${snapshot.positions.length} open, ${snapshot.hedgePositions.length} classified as hedges`,
  )

  const safety = assessSafety({
    poolHealthStatus: snapshot.pool.healthStatus,
    isLiquidatable: snapshot.liquidation.isLiquidatable,
  })
  console.log('safety:', safety)

  const plan = computeHedgePlan({
    pool: snapshot.pool,
    collateral: snapshot.collateral,
    signalTick: signal.tick,
    assetIndex: config.ASSET_INDEX as 0n | 1n,
    deltaThresholdBps: config.DELTA_THRESHOLD_BPS,
    deltaOffsetBps: config.DELTA_OFFSET_BPS,
    absoluteMaxHedgeCount: config.MAX_HEDGE_SLOTS,
    slippageBps: BigInt(config.SLIPPAGE_BPS),
    positions: snapshot.positions,
    hedgePositions: snapshot.hedgePositions,
  })

  // ---- Step-by-step delta breakdown (vault-asset frame) --------------------
  const b = plan.breakdown
  const assetIsToken0 = b.assetIndex === 0n
  const assetDecimals = Number(assetIsToken0 ? metadata.token0Decimals : metadata.token1Decimals)
  const assetSymbol = assetIsToken0 ? metadata.token0Symbol : metadata.token1Symbol
  const h = (value: bigint): string => `${formatUnits(value, assetDecimals)} ${assetSymbol}`

  console.log(
    `\n=== DELTA BREAKDOWN (vault asset = ${assetSymbol}, assetIndex=${b.assetIndex}) ===`,
  )
  console.log(
    `markTick (delta marking = pool spot) = ${b.poolCurrentTick}   signalTick = ${b.signalTick}   gap = ${b.poolCurrentTick - b.signalTick}`,
  )
  console.log('\n-- per-position, per-leg delta (vault frame) --')
  for (const p of b.portfolio.positions) {
    console.log(
      `position ${p.tokenId}  size=${p.positionSize}  tickAtMint=${p.tickAtMint}  → total ${h(p.total)}`,
    )
    for (const leg of p.legs) {
      console.log(
        `    leg${leg.index} ${leg.kind.padEnd(6)} asset=${leg.asset} tokenType=${leg.tokenType} isLong=${leg.isLong} width=${leg.width}  → ${h(leg.delta)}`,
      )
    }
  }
  console.log(`\npositionsDelta  (Σ ALL positions incl. hedge loans) = ${h(b.positionsDelta)}`)
  console.log(
    `collateral      token0.assets=${b.collateralToken0Assets}  token1.assets=${b.collateralToken1Assets}`,
  )
  console.log(`collateralDelta (asset-side, vault frame)            = ${h(b.collateralDelta)}`)
  console.log(`netDelta        = positionsDelta + collateralDelta   = ${h(b.netDelta)}`)
  console.log('\n-- hedge book (H) --')
  for (const item of b.hedges) {
    console.log(`    hedge ${item.tokenId}  tokenType=${item.tokenType}  size=${h(item.size)}`)
  }
  console.log(`H_short=${h(b.H_short)}  H_long=${h(b.H_long)}  H = H_long - H_short = ${h(b.H)}`)
  console.log(`Hstar = H - netDelta = ${h(plan.Hstar)}   portfolioSize = ${h(b.portfolioSize)}`)
  console.log(
    `driftBps = |netDelta| / sizeBasis = ${plan.driftBps}  (threshold ${config.DELTA_THRESHOLD_BPS})`,
  )

  console.log('\nplan:', {
    action: plan.action,
    netDelta: plan.netDelta.toString(),
    H: plan.H.toString(),
    Hstar: plan.Hstar.toString(),
    driftBps: plan.driftBps.toString(),
    triggers: plan.triggers,
    openTokenId: plan.intent.openTokenId?.toString() ?? null,
    openPositionSize: plan.intent.openPositionSize?.toString() ?? null,
    closeTokenIds: plan.intent.closeTokenIds.map((id) => id.toString()),
    swapAtMint: plan.intent.swapAtMint,
  })
}

main().catch((err) => {
  console.error(sanitizeError(err))
  process.exit(1)
})
