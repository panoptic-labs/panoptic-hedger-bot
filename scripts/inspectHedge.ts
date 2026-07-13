import 'dotenv/config'

import { getPool } from '@panoptic-eng/sdk/v2'
import { createPublicClient, http } from 'viem'

import { parseHedgerBotConfig } from '../src/config'
import { computeHedgePlan } from '../src/hedge/decision'
import { readSafePositions } from '../src/hedge/positionReader'
import { assessSafety } from '../src/hedge/safety'
import { createPriceSignalSource } from '../src/priceSignal'
import { defineBotChain } from '../src/utils/chain'
import { asSdkClient } from '../src/utils/sdkClient'

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

  const priceSource = createPriceSignalSource(config, { publicClient })
  const signal = await priceSource.getSignal()
  console.log('signal:', {
    source: signal.source,
    tick: signal.tick.toString(),
    observedAtMs: signal.observedAtMs,
  })

  const read = await readSafePositions({
    publicClient,
    poolAddress: config.POOL_ADDRESS,
    chainId,
    safeAddress: config.SAFE_ADDRESS,
    trackedHedgeIds: new Set(),
  })
  console.log(
    `positions: ${read.positions.length} open, ${read.hedgePositions.length} classified as hedges`,
  )

  const pool = await getPool({
    client: asSdkClient<typeof getPool>(publicClient),
    poolAddress: config.POOL_ADDRESS,
    chainId,
  })
  const safety = await assessSafety({
    publicClient,
    poolAddress: config.POOL_ADDRESS,
    safeAddress: config.SAFE_ADDRESS,
    tokenIds: read.positions.map((p) => p.tokenId),
    poolHealthStatus: pool.healthStatus,
  })
  console.log('safety:', safety)

  const plan = await computeHedgePlan({
    publicClient,
    poolAddress: config.POOL_ADDRESS,
    chainId,
    safeAddress: config.SAFE_ADDRESS,
    signalTick: signal.tick,
    assetIndex: config.ASSET_INDEX as 0n | 1n,
    deltaThresholdBps: config.DELTA_THRESHOLD_BPS,
    absoluteMaxHedgeCount: config.MAX_HEDGE_SLOTS,
    slippageBps: BigInt(config.SLIPPAGE_BPS),
    positions: read.positions,
    hedgePositions: read.hedgePositions,
  })

  console.log('plan:', {
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
  console.error(err)
  process.exit(1)
})
