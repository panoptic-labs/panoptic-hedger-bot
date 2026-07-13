import 'dotenv/config'

import { fileURLToPath } from 'node:url'

import { getPoolMetadata } from '@panoptic-eng/sdk/v2'
import { createPublicClient, createWalletClient, http } from 'viem'

import { parseHedgerBotConfig } from './config'
import { createHedgeExecutor } from './executor'
import { createGasPolicy } from './gas/gasPolicy'
import { HedgerBot } from './hedgerBot'
import { createTelegramNotifier } from './notify/telegram'
import { createPriceSignalSource } from './priceSignal'
import { isActivated } from './runtime/activation'
import {
  botVersion,
  clearRuntimeState,
  patchRuntimeState,
  writeRuntimeState,
} from './runtime/stateFile'
import { resolveBotAccount } from './safe/resolveBotAccount'
import { createRolesExecutor } from './safe/rolesExecutor'
import { parseBuilderCode } from './utils/builderCode'
import { defineBotChain } from './utils/chain'
import { botError, botLog, botWarn } from './utils/log'
import { asSdkClient } from './utils/sdkClient'
import { sleep } from './utils/sleep'

const STARTUP_RETRY_DELAYS_MS = [15_000, 60_000, 120_000, 300_000] as const

async function initWithRetry(init: () => Promise<void>): Promise<void> {
  let attempt = 0
  for (;;) {
    try {
      await init()
      return
    } catch (error) {
      const delay = STARTUP_RETRY_DELAYS_MS[Math.min(attempt, STARTUP_RETRY_DELAYS_MS.length - 1)]
      botError(`[hedger-bot] init failed (attempt ${attempt + 1}); retrying in ${delay}ms`, error)
      attempt += 1
      await sleep(delay)
    }
  }
}

async function main(): Promise<void> {
  const parsed = parseHedgerBotConfig()

  // Two-stage go-live: the bot trades for real ONLY when an activation marker
  // (written by `pnpm activate` after a passing preflight) matches this Safe/
  // pool/chain. Without it we force dry-run even if DRY_RUN=false, so nobody
  // goes live by editing one env var. DRY_RUN=true still forces dry-run.
  const activated = isActivated(parsed)
  const effectiveDryRun = parsed.DRY_RUN || !activated
  const config = { ...parsed, DRY_RUN: effectiveDryRun }
  if (!activated && !parsed.DRY_RUN) {
    botWarn(
      '[hedger-bot] NOT ACTIVATED — forcing DRY_RUN. Run `pnpm activate` to go live (it runs preflight first).',
    )
  }
  // Narrowed v1: warn when an experimental (non-core) feature is configured.
  const experimental: string[] = []
  if (config.HEDGE_VENUE !== 'in-pool') experimental.push(`HEDGE_VENUE=${config.HEDGE_VENUE}`)
  if (config.PRICE_SIGNAL_SOURCE === 'uniswap-pool')
    experimental.push('PRICE_SIGNAL_SOURCE=uniswap-pool')
  if (experimental.length > 0) {
    botWarn(
      `[hedger-bot] EXPERIMENTAL feature(s) enabled (not covered by v1 support): ${experimental.join(', ')}`,
    )
  }

  const chain = defineBotChain(config.CHAIN_ID, config.RPC_URL)

  const account = await resolveBotAccount(config)
  const publicClient = createPublicClient({ chain, transport: http(config.RPC_URL) })
  const walletClient = createWalletClient({ account, chain, transport: http(config.RPC_URL) })

  const notifier = createTelegramNotifier(config)
  const gasPolicy = createGasPolicy({ publicClient, account, notifier, config })

  const rolesExecutor = createRolesExecutor({
    publicClient,
    walletClient,
    account,
    rolesModifierAddress: config.ROLES_MODIFIER_ADDRESS,
    roleKey: config.ROLE_KEY,
    safeAddress: config.SAFE_ADDRESS,
    chain,
    fees: () => gasPolicy.fees(),
  })

  const executor = createHedgeExecutor(config, {
    publicClient,
    poolAddress: config.POOL_ADDRESS,
    safeAddress: config.SAFE_ADDRESS,
    rolesExecutor,
    builderCode: parseBuilderCode(config.PANOPTIC_BUILDER_CODE),
  })

  // Pool token decimals (needed by the cex signal to convert USD price → tick).
  const metadata = await getPoolMetadata({
    client: asSdkClient<typeof getPoolMetadata>(publicClient),
    poolAddress: config.POOL_ADDRESS,
  })
  // Which token is ETH (the cex-priced asset): the non-stable side of the pair.
  // This orients the cex price into the pool tick and is independent of
  // ASSET_INDEX (the delta-accounting frame the user chooses freely).
  const STABLES = new Set(['USDC', 'USDT', 'DAI', 'USDC.E', 'USDBC', 'FRAX', 'LUSD', 'GUSD'])
  const token0IsStable = STABLES.has(metadata.token0Symbol.toUpperCase())
  const ethTokenIndex: 0n | 1n = token0IsStable ? 1n : 0n

  const priceSource = createPriceSignalSource(config, {
    publicClient,
    token0Decimals: BigInt(metadata.token0Decimals),
    token1Decimals: BigInt(metadata.token1Decimals),
    ethTokenIndex,
  })
  // The sizing (vault-asset) token — the frame netDelta/H/H* are reported in.
  const vaultAsset =
    config.ASSET_INDEX === 0n
      ? { decimals: Number(metadata.token0Decimals), symbol: metadata.token0Symbol }
      : { decimals: Number(metadata.token1Decimals), symbol: metadata.token1Symbol }

  // Heartbeat file so `pnpm status` (a separate process) can see running-state
  // and last poll/hedge. Written before the loop; updated each cycle.
  writeRuntimeState({
    pid: process.pid,
    version: botVersion(),
    startedAt: new Date().toISOString(),
    dryRun: config.DRY_RUN,
    chainId: config.CHAIN_ID,
    safe: config.SAFE_ADDRESS,
    pool: config.POOL_ADDRESS,
  })

  const bot = new HedgerBot({
    config,
    publicClient,
    account,
    priceSource,
    executor,
    rolesExecutor,
    notifier,
    gasPolicy,
    vaultAsset,
    recordPoll: (trigger) =>
      patchRuntimeState({ lastPollAt: new Date().toISOString(), lastPollTrigger: trigger }),
    recordHedge: (action, tx) =>
      patchRuntimeState({
        lastHedgeAt: new Date().toISOString(),
        lastHedgeAction: action,
        lastHedgeTx: tx,
      }),
  })

  botLog(
    `[hedger-bot] starting: chain=${config.CHAIN_ID} pool=${config.POOL_ADDRESS} safe=${config.SAFE_ADDRESS} ` +
      `signal=${config.PRICE_SIGNAL_SOURCE} dryRun=${config.DRY_RUN}${activated ? '' : ' (forced: not activated)'} ` +
      `interval=${config.POLL_INTERVAL_MS}ms`,
  )

  await initWithRetry(() => bot.init())

  // Retry the first cycle with the same backoff — a transient RPC failure on the
  // startup cycle shouldn't abort boot.
  await initWithRetry(() => bot.runCycle('startup'))
  const pollTimer = setInterval(() => {
    void bot.runCycle('poll')
  }, config.POLL_INTERVAL_MS)

  // Release background resources (CEX WebSocket feeds, poll timer) on shutdown.
  const shutdown = (signal: string) => {
    botLog(`[hedger-bot] received ${signal}, shutting down`)
    clearInterval(pollTimer)
    priceSource.stop?.()
    clearRuntimeState()
    process.exit(0)
  }
  process.once('SIGINT', () => shutdown('SIGINT'))
  process.once('SIGTERM', () => shutdown('SIGTERM'))
}

const entrypoint = process.argv[1]
if (entrypoint && fileURLToPath(import.meta.url) === entrypoint) {
  main().catch((err) => {
    botError('[hedger-bot] fatal', err)
    process.exit(1)
  })
}
