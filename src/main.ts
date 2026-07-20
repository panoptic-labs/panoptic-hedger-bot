import 'dotenv/config'

import { fileURLToPath } from 'node:url'

import { createMemoryStorage, getPoolMetadata } from '@panoptic-eng/sdk/v2'
import { createPublicClient, createWalletClient, http } from 'viem'

import { parseHedgerBotConfig } from './config'
import { createHedgeExecutor } from './executor'
import { createGasPolicy } from './gas/gasPolicy'
import { type CycleOutcome, HedgerBot } from './hedgerBot'
import { createTelegramNotifier } from './notify/telegram'
import { createPriceSignalSource } from './priceSignal'
import { resolveCexAssetOrientation } from './priceSignal/cexSource'
import { buildActivationEvidence, isActivated } from './runtime/activation'
import { assertTradingEnabled, isDeactivated } from './runtime/deactivation'
import { HedgeJournal } from './runtime/hedgeJournal'
import {
  type InstanceLeaseHeartbeat,
  acquireInstanceLease,
  startInstanceLeaseHeartbeat,
} from './runtime/instanceLease'
import {
  botVersion,
  clearRuntimeState,
  patchRuntimeState,
  readRuntimeState,
  writeRuntimeState,
} from './runtime/stateFile'
import { resolveBotAccount } from './safe/resolveBotAccount'
import { createRolesExecutor } from './safe/rolesExecutor'
import { assertProductionEligibleConfig } from './security/productionProfile'
import { parseBuilderCode } from './utils/builderCode'
import { defineBotChain } from './utils/chain'
import { botError, botLog, botWarn } from './utils/log'
import { sanitizeError } from './utils/sanitize'
import { asSdkClient } from './utils/sdkClient'
import { sleep } from './utils/sleep'

const STARTUP_RETRY_DELAYS_MS = [15_000, 60_000, 120_000, 300_000] as const

async function initWithRetry(
  init: () => Promise<void>,
  recordFailure: (attempt: number, error: unknown) => void,
): Promise<void> {
  let attempt = 0
  for (;;) {
    try {
      await init()
      return
    } catch (error) {
      attempt += 1
      recordFailure(attempt, error)
      if (attempt > STARTUP_RETRY_DELAYS_MS.length) throw error
      const delay = STARTUP_RETRY_DELAYS_MS[attempt - 1]
      botError(`[hedger-bot] init failed (attempt ${attempt}); retrying in ${delay}ms`, error)
      await sleep(delay)
    }
  }
}

function errorClass(error: unknown): string {
  return error instanceof Error ? error.name.slice(0, 128) : 'UnknownError'
}

async function main(): Promise<void> {
  const parsed = parseHedgerBotConfig()

  const chain = defineBotChain(parsed.CHAIN_ID, parsed.RPC_URL)
  const account = await resolveBotAccount(parsed)
  const publicClient = createPublicClient({ chain, transport: http(parsed.RPC_URL) })
  const evidence = await (async () => {
    assertProductionEligibleConfig(parsed)
    return buildActivationEvidence(publicClient, parsed)
  })().catch((error) => {
    botWarn(
      `[hedger-bot] activation evidence unavailable; forcing DRY_RUN: ${sanitizeError(error)}`,
    )
    return undefined
  })

  // Two-stage go-live: the bot trades for real ONLY when an activation marker
  // (written by `pnpm activate` after a passing preflight) matches this Safe/
  // pool/chain. Without it we force dry-run even if DRY_RUN=false, so nobody
  // goes live by editing one env var. DRY_RUN=true still forces dry-run.
  const activated = !isDeactivated() && isActivated(parsed, account.address, evidence)
  const effectiveDryRun = parsed.DRY_RUN || !activated
  const config = { ...parsed, DRY_RUN: effectiveDryRun }
  if (!activated && !parsed.DRY_RUN) {
    botWarn(
      '[hedger-bot] NOT ACTIVATED — forcing DRY_RUN. Run `pnpm activate` to go live (it runs preflight first).',
    )
  }
  if (config.PRICE_SIGNAL_SOURCE === 'uniswap-pool') {
    botWarn(
      '[hedger-bot] EXPERIMENTAL feature enabled (not covered by v1 support): ' +
        'PRICE_SIGNAL_SOURCE=uniswap-pool',
    )
  }

  const instanceLease = acquireInstanceLease({
    signer: account.address,
    safe: config.SAFE_ADDRESS,
    pool: config.POOL_ADDRESS,
  })
  const instanceId = instanceLease.instanceId
  process.once('exit', () => instanceLease.release())

  const walletClient = createWalletClient({ account, chain, transport: http(config.RPC_URL) })

  const notifier = createTelegramNotifier(config, fetch, (result) => {
    const state = readRuntimeState()
    if (!state || state.instanceId !== instanceId) return
    const now = new Date().toISOString()
    const failures = result === 'failure' ? (state.notificationConsecutiveFailures ?? 0) + 1 : 0
    patchRuntimeState(instanceId, {
      notificationConsecutiveFailures: failures,
      notificationLastSuccessAt: result === 'success' ? now : state.notificationLastSuccessAt,
      notificationLastFailureAt: result === 'failure' ? now : state.notificationLastFailureAt,
      lifecycle: failures >= 3 ? 'degraded' : state.lifecycle,
    })
  })
  const gasPolicy = createGasPolicy({ publicClient, account, notifier, config })
  const hedgeJournal = new HedgeJournal({
    chainId: config.CHAIN_ID,
    safe: config.SAFE_ADDRESS,
    pool: config.POOL_ADDRESS,
    signer: account.address,
  })

  const rolesExecutor = createRolesExecutor({
    publicClient,
    walletClient,
    account,
    rolesModifierAddress: config.ROLES_MODIFIER_ADDRESS,
    roleKey: config.ROLE_KEY,
    safeAddress: config.SAFE_ADDRESS,
    chain,
    fees: (opts) => gasPolicy.fees(opts),
    bumpFees: (prev, opts) => gasPolicy.bumped(prev, opts),
    txWait: {
      timeoutMs: config.TX_RECEIPT_TIMEOUT_MS,
      bumpIntervalMs: config.TX_BUMP_INTERVAL_MS,
    },
    observeTransaction: (update) => hedgeJournal.observeTransaction(update),
    assertSendAllowed: () => {
      assertTradingEnabled()
      instanceLease.assertOwned()
    },
  })

  const executor = createHedgeExecutor(config, {
    poolAddress: config.POOL_ADDRESS,
    publicClient,
    rolesExecutor,
    builderCode: parseBuilderCode(config.PANOPTIC_BUILDER_CODE),
  })

  // Pool token decimals (needed by the cex signal to convert USD price → tick).
  const metadata = await getPoolMetadata({
    client: asSdkClient<typeof getPoolMetadata>(publicClient),
    poolAddress: config.POOL_ADDRESS,
  })
  const ethTokenIndex =
    config.PRICE_SIGNAL_SOURCE === 'cex'
      ? resolveCexAssetOrientation(config.CHAIN_ID, metadata.token0Asset, metadata.token1Asset)
      : undefined

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
    schemaVersion: 2,
    instanceId,
    pid: process.pid,
    signer: account.address,
    version: botVersion(),
    startedAt: new Date().toISOString(),
    updatedAt: new Date().toISOString(),
    dryRun: config.DRY_RUN,
    chainId: config.CHAIN_ID,
    safe: config.SAFE_ADDRESS,
    pool: config.POOL_ADDRESS,
    pollIntervalMs: config.POLL_INTERVAL_MS,
    lifecycle: 'starting',
    ready: false,
    initAttempts: 0,
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
    hedgeJournal,
    storage: createMemoryStorage(),
    vaultAsset,
    recordPoll: (trigger) =>
      patchRuntimeState(instanceId, {
        lastPollAt: new Date().toISOString(),
        lastPollTrigger: trigger,
      }),
    recordHedge: (action, tx) =>
      patchRuntimeState(instanceId, {
        lastHedgeAt: new Date().toISOString(),
        lastHedgeAction: action,
        lastHedgeTx: tx,
      }),
  })

  const recordCycle = (outcome: CycleOutcome) => {
    if (outcome === 'in-flight') return
    const state = readRuntimeState()
    if (!state || state.instanceId !== instanceId) {
      throw new Error('runtime heartbeat ownership lost during cycle')
    }
    const signalFailures =
      outcome === 'signal-unavailable' ? (state.consecutiveSignalFailures ?? 0) + 1 : 0
    patchRuntimeState(instanceId, {
      lastPollCompletedAt: new Date().toISOString(),
      lastCycleOutcome: outcome,
      consecutiveSignalFailures: signalFailures,
      ready: outcome === 'complete' ? true : state.ready,
      lifecycle:
        outcome === 'complete'
          ? (state.notificationConsecutiveFailures ?? 0) >= 3
            ? 'degraded'
            : 'ready'
          : outcome === 'error' || signalFailures >= 3
            ? 'degraded'
            : state.lifecycle,
    })
  }
  let activeCycle: Promise<CycleOutcome> | null = null
  const runAndRecord = (trigger: string): Promise<CycleOutcome> => {
    if (activeCycle) return Promise.resolve('in-flight')
    const pending = bot.runCycle(trigger).then((outcome) => {
      recordCycle(outcome)
      return outcome
    })
    activeCycle = pending
    const clear = () => {
      if (activeCycle === pending) activeCycle = null
    }
    void pending.then(clear, clear)
    return pending
  }
  botLog(
    `[hedger-bot] starting: chain=${config.CHAIN_ID} pool=${config.POOL_ADDRESS} safe=${config.SAFE_ADDRESS} ` +
      `signal=${config.PRICE_SIGNAL_SOURCE} dryRun=${config.DRY_RUN}${activated ? '' : ' (forced: not activated)'} ` +
      `interval=${config.POLL_INTERVAL_MS}ms`,
  )

  const recordInitFailure = (attempt: number, error: unknown) =>
    patchRuntimeState(instanceId, {
      initAttempts: attempt,
      lastInitErrorCode: errorClass(error),
      lifecycle: attempt > STARTUP_RETRY_DELAYS_MS.length ? 'failed' : 'starting',
      ready: false,
    })

  let pollTimer: ReturnType<typeof setInterval> | undefined
  let leaseHeartbeat: InstanceLeaseHeartbeat | undefined
  // Register before startup RPC work so termination still releases state,
  // signer resources, and the single-instance lease during initialization.
  let shuttingDown = false
  const shutdown = async (signal: string, exitCode = 0) => {
    if (shuttingDown) return
    shuttingDown = true
    botLog(`[hedger-bot] received ${signal}, shutting down`)
    if (pollTimer) clearInterval(pollTimer)
    leaseHeartbeat?.stop()
    priceSource.stop?.()
    if (activeCycle) {
      await Promise.race([activeCycle.catch(() => undefined), sleep(15_000)])
    }
    clearRuntimeState(instanceId)
    instanceLease.release()
    process.exit(exitCode)
  }
  process.once('SIGINT', () => void shutdown('SIGINT'))
  process.once('SIGTERM', () => void shutdown('SIGTERM'))

  // Start renewal before any initialization or startup-cycle RPC work. A slow
  // first hedge must not outlive the 30-second lease and fence its own process.
  leaseHeartbeat = startInstanceLeaseHeartbeat(instanceLease, (error) => {
    try {
      patchRuntimeState(instanceId, {
        lifecycle: 'failed',
        ready: false,
        lastInitErrorCode: errorClass(error),
      })
    } catch {
      // The lease/runtime fence may have disappeared together.
    }
    void shutdown('instance lease lost', 1)
  })

  await initWithRetry(() => bot.init(), recordInitFailure)

  // Retry the first cycle with the same backoff — a transient RPC failure on the
  // startup cycle shouldn't abort boot.
  await initWithRetry(async () => {
    const outcome = await runAndRecord('startup')
    if (outcome !== 'complete') {
      throw new Error('startup cycle did not reach readiness')
    }
  }, recordInitFailure)
  pollTimer = setInterval(() => {
    void runAndRecord('poll').catch((error) => {
      botError('[hedger-bot] poll cycle rejected', error)
    })
  }, config.POLL_INTERVAL_MS)
}

const entrypoint = process.argv[1]
if (entrypoint && fileURLToPath(import.meta.url) === entrypoint) {
  main().catch((err) => {
    botError('[hedger-bot] fatal', err)
    process.exit(1)
  })
}
