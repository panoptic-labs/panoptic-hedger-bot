import { type StorageAdapter, isNonceError, isRetryableRpcError } from '@panoptic-eng/sdk/v2'
import type { Account, Hex, PublicClient } from 'viem'
import { formatUnits } from 'viem'

import type { HedgerBotConfig } from './config'
import { protocolGenesisBlock } from './constants/genesis'
import type { HedgeExecutor, HedgeIntent } from './executor/types'
import type { GasPolicy } from './gas/gasPolicy'
import { computeHedgePlan } from './hedge/decision'
import { type MarginReserveAssessment, assessMarginReserve } from './hedge/marginReserve'
import { assessSafety } from './hedge/safety'
import { readHedgeSnapshot } from './hedge/snapshot'
import type { Notifier } from './notify/telegram'
import { formatCycleSummary, formatError, formatSkip } from './presenters/summary'
import { type PriceSignalSource, PriceSignalUnavailableError } from './priceSignal'
import { type HedgeJournalPort, createHedgeRecoveryClient } from './runtime/hedgeJournal'
import { type RolesExecutor, TxNotMinedError } from './safe/rolesExecutor'
import { botError, botLog, botWarn } from './utils/log'
import { sanitizeError } from './utils/sanitize'

export interface HedgerBotDeps {
  config: HedgerBotConfig
  publicClient: PublicClient
  account: Account
  priceSource: PriceSignalSource
  executor: HedgeExecutor
  rolesExecutor: RolesExecutor
  notifier: Notifier
  gasPolicy: GasPolicy
  hedgeJournal: HedgeJournalPort
  /** Persistence for the SDK position sync (in-memory; per-process cache). */
  storage: StorageAdapter
  /**
   * Decimals + symbol of the sizing (vault-asset) token — the frame that
   * netDelta/H/H* are denominated in (config.ASSET_INDEX). Used only to render
   * those amounts as human-readable token quantities in the poll log.
   */
  vaultAsset: { decimals: number; symbol: string }
  /** Heartbeat hooks so a status command can see last poll / last hedge. */
  recordPoll?: (trigger: string) => void
  recordHedge?: (action: string, tx?: Hex) => void
}

export type CycleOutcome = 'complete' | 'signal-unavailable' | 'error' | 'in-flight'

async function assessFinalStateReserve(
  executor: HedgeExecutor,
  intent: HedgeIntent,
  blockNumber: bigint,
  reserveBps: bigint,
): Promise<MarginReserveAssessment> {
  const preview = await executor.previewFinalState(intent, blockNumber)
  if (!preview.success) {
    return { sufficient: false, free0: 0n, free1: 0n, reasons: [preview.reason] }
  }
  return assessMarginReserve(preview.margin, reserveBps, true)
}

/**
 * Orchestrates one hedging cycle: read price signal → read Safe positions →
 * safety gate → compute plan → execute via Roles → update transaction recovery →
 * notify. Cycles never overlap (isCycleInFlight gate).
 */
export class HedgerBot {
  private readonly deps: HedgerBotDeps
  private isCycleInFlight = false
  private lastDispatchTxHash?: Hex

  constructor(deps: HedgerBotDeps) {
    this.deps = deps
  }

  /** One-time startup: verify the Roles modifier is wired to the Safe. */
  async init(): Promise<void> {
    await this.deps.rolesExecutor.preflight()
    await this.deps.hedgeJournal.recover(createHedgeRecoveryClient(this.deps.publicClient))
    const checkpoint = this.deps.hedgeJournal.checkpoint()
    this.lastDispatchTxHash = checkpoint.transactionHash
    await this.deps.notifier.notify('🤖 hedger-bot started')
  }

  async runCycle(trigger: string): Promise<CycleOutcome> {
    if (this.isCycleInFlight) {
      botLog(`[hedger-bot] cycle already in flight; skipping ${trigger}`)
      return 'in-flight'
    }
    this.isCycleInFlight = true
    try {
      const completed = await this.doCycle(trigger)
      return completed === false ? 'signal-unavailable' : 'complete'
    } catch (error) {
      botError(`[hedger-bot] cycle error (${trigger})`, error)
      // Retryable transient RPC/nonce errors: let the next cycle retry silently.
      if (!isRetryableRpcError(error) && !isNonceError(error)) {
        await this.deps.notifier.notify(formatError(trigger, error))
      }
      return 'error'
    } finally {
      this.isCycleInFlight = false
    }
  }

  private async doCycle(trigger: string): Promise<void | false> {
    const { config, publicClient, priceSource, executor, notifier, gasPolicy } = this.deps
    this.deps.recordPoll?.(trigger)
    const poolAddress = config.POOL_ADDRESS
    const safeAddress = config.SAFE_ADDRESS
    const chainId = BigInt(config.CHAIN_ID)

    // Keeper gas-money watchdog — never let a balance check fail the cycle.
    await gasPolicy.checkKeeperBalance().catch((error) => {
      botWarn('[hedger-bot] keeper balance check failed ' + sanitizeError(error))
    })

    let signal
    try {
      signal = await priceSource.getSignal()
    } catch (error) {
      // Warmup / transient staleness (e.g. cex feeds still connecting at startup)
      // is an expected soft skip — log and wait for the next cycle, don't error.
      if (error instanceof PriceSignalUnavailableError) {
        botLog(
          `[hedger-bot] price signal unavailable (${trigger}): ${sanitizeError(error)} — skipping`,
        )
        return false
      }
      throw error
    }
    botLog(
      `[hedger-bot] signal source=${signal.source} tick=${signal.tick}` +
        (signal.price !== undefined ? ` price=${signal.price}` : '') +
        (signal.detail ? ` ${signal.detail}` : ''),
    )

    const snapshotBlock = signal.blockNumber ?? (await publicClient.getBlockNumber())

    const snapshot = await readHedgeSnapshot({
      publicClient,
      poolAddress,
      chainId,
      safeAddress,
      storage: this.deps.storage,
      fromBlock: config.SYNC_FROM_BLOCK ?? protocolGenesisBlock(config.CHAIN_ID),
      blockNumber: snapshotBlock,
    })
    const { pool, buyingPower: bp } = snapshot
    const legCount = snapshot.positions.reduce((n, position) => n + position.legs.length, 0)
    const free0 =
      bp.collateralBalance0 > bp.requiredCollateral0
        ? bp.collateralBalance0 - bp.requiredCollateral0
        : 0n
    const free1 =
      bp.collateralBalance1 > bp.requiredCollateral1
        ? bp.collateralBalance1 - bp.requiredCollateral1
        : 0n
    const m = pool.metadata
    const f0 = (v: bigint) => `${formatUnits(v, Number(m.token0Decimals))} ${m.token0Symbol}`
    const f1 = (v: bigint) => `${formatUnits(v, Number(m.token1Decimals))} ${m.token1Symbol}`
    const outOfRange = snapshot.positions.filter((p) =>
      p.legs.some(
        (leg) =>
          leg.width > 0n && (pool.currentTick < leg.tickLower || pool.currentTick > leg.tickUpper),
      ),
    )
    const oorNote =
      outOfRange.length > 0
        ? ` ⚠️ outOfRange=${outOfRange.length}/${snapshot.positions.length} [${outOfRange
            .map((p) => p.tokenId)
            .join(', ')}]`
        : ''
    botLog(
      `[hedger-bot] portfolio positions=${snapshot.positions.length} legs=${legCount} ` +
        `collateral=[${f0(bp.collateralBalance0)}, ${f1(bp.collateralBalance1)}] ` +
        `buyingPower=[${f0(free0)}, ${f1(free1)}] ` +
        `marginUsed=[${f0(bp.requiredCollateral0)}, ${f1(bp.requiredCollateral1)}]${oorNote}`,
    )

    const safety = assessSafety({
      poolHealthStatus: pool.healthStatus,
      isLiquidatable: snapshot.liquidation.isLiquidatable,
    })
    if (!safety.safe) {
      botWarn(`[hedger-bot] unsafe (${trigger}): ${safety.reasons.join('; ')}`)
      await notifier.notify(formatSkip(trigger, safety.reasons))
      return
    }

    const tickGap =
      signal.tick > pool.currentTick
        ? signal.tick - pool.currentTick
        : pool.currentTick - signal.tick
    if (tickGap > BigInt(config.SIGNAL_TICK_SANITY_MAX)) {
      const msg =
        `signal tick ${signal.tick} vs pool tick ${pool.currentTick} differ by ${tickGap} ` +
        `(> ${config.SIGNAL_TICK_SANITY_MAX}). Likely a misconfigured signal — check ` +
        `ASSET_INDEX (a wrong value inverts the price) and the pool/source pairing.`
      botWarn(`[hedger-bot] signal sanity check failed (${trigger}): ${msg} — skipping`)
      await notifier.notify(formatSkip(trigger, [msg]))
      return
    }

    const plan = computeHedgePlan({
      pool,
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

    if (plan.intent.openTokenId !== null) {
      const margin = await assessFinalStateReserve(
        executor,
        plan.intent,
        snapshotBlock,
        config.MIN_MARGIN_RESERVE_BPS,
      )
      if (!margin.sufficient) {
        botWarn(
          `[hedger-bot] final-state preflight blocked (${trigger}): ${margin.reasons.join('; ')}`,
        )
        await notifier.notify(formatSkip(trigger, margin.reasons))
        return
      }
    }

    const { decimals, symbol } = this.deps.vaultAsset
    const asset = (v: bigint) => `${formatUnits(v, decimals)} ${symbol}`
    botLog(
      `[hedger-bot] ${trigger} action=${plan.action} netDelta=${asset(plan.netDelta)} ` +
        `H=${asset(plan.H)} H*=${asset(plan.Hstar)} drift=${plan.driftBps}bps`,
    )

    if (plan.action === 'none') return

    // Urgent = large drift; loosens the basefee deferral gate AND lifts the
    // priority-tip floor on the send (threaded via ctx → rolesExecutor.send).
    const urgent =
      plan.driftBps >= config.DELTA_THRESHOLD_BPS * BigInt(config.URGENT_DRIFT_MULTIPLIER)

    // Gas deferral gate — hedging is discretionary. Routine hedges wait out
    // basefee spikes; urgent hedges tolerate a much higher basefee. Dry-runs
    // spend no gas and skip the gate so planning stays observable during spikes.
    if (!config.DRY_RUN) {
      const gas = await gasPolicy.assess(urgent)
      if (!gas.proceed) {
        const reason =
          `basefee ${gas.baseFeeGwei} gwei > ${gas.capGwei} gwei ` +
          `${gas.urgent ? 'urgent' : 'hedge'} cap — deferring`
        botWarn(`[hedger-bot] gas deferral (${trigger}): ${reason}`)
        if (gas.shouldNotifySkip) await notifier.notify(formatSkip(trigger, [reason]))
        return
      }
    }

    const ctx = { urgent }
    let result
    let journalStarted = false
    try {
      if (!config.DRY_RUN && plan.intent.openTokenId !== null) {
        const preSendBlock = await publicClient.getBlockNumber()
        const latestMargin = await assessFinalStateReserve(
          executor,
          plan.intent,
          preSendBlock,
          config.MIN_MARGIN_RESERVE_BPS,
        )
        if (!latestMargin.sufficient) {
          botWarn(
            `[hedger-bot] final-state preflight changed before send (${trigger}): ` +
              latestMargin.reasons.join('; '),
          )
          await notifier.notify(formatSkip(trigger, latestMargin.reasons))
          return
        }
      }
      if (!config.DRY_RUN) {
        this.deps.hedgeJournal.begin(plan.action)
        journalStarted = true
      }
      result = await executor.execute(plan.intent, ctx)
    } catch (error) {
      if (journalStarted) this.deps.hedgeJournal.fail()
      // The send confirmed nothing within the receipt budget despite fee-bumped
      // replacements. Same semantics as the old receipt timeout: alert, remember
      // the best-guess hash for the next cycle's re-read, tracker untouched.
      if (error instanceof TxNotMinedError) {
        this.lastDispatchTxHash = error.lastHash
        botError('[hedger-bot] dispatch not mined', error)
        await notifier.notify(formatError(trigger, error))
        return
      }
      throw error
    }

    // Only a confirmed successful dispatch may update the recovery journal.
    if (!result.dryRun) {
      const receipt = result.receipt
      if (!receipt || !result.transactionHash) {
        if (journalStarted) this.deps.hedgeJournal.fail()
        throw new Error('live executor returned without a confirmed transaction receipt')
      }
      this.lastDispatchTxHash = receipt.transactionHash
      if (receipt.status !== 'success') {
        this.deps.hedgeJournal.fail()
        throw new Error(`dispatch reverted: ${receipt.transactionHash}`)
      }
      this.deps.hedgeJournal.confirm({
        transactionHash: receipt.transactionHash,
        blockNumber: receipt.blockNumber,
        blockHash: receipt.blockHash,
      })
      this.deps.recordHedge?.(plan.action, receipt.transactionHash)
    }

    // Same message to the console and Telegram, so an executed hedge is easy to
    // spot in the logs and mirrors the alert exactly.
    const summary = formatCycleSummary(plan, result, trigger, this.deps.vaultAsset)
    botLog(`\n${summary}`)
    await notifier.notify(summary)
  }
}
