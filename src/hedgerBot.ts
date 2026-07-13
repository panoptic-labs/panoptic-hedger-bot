import {
  getAccountBuyingPower,
  getPool,
  isNonceError,
  isRetryableRpcError,
  tickToSqrtPriceX96,
} from '@panoptic-eng/sdk/v2'
import type { Account, Hex, PublicClient } from 'viem'
import { formatUnits } from 'viem'

import type { HedgerBotConfig } from './config'
import type { HedgeExecutor } from './executor/types'
import type { GasPolicy } from './gas/gasPolicy'
import { computeHedgePlan } from './hedge/decision'
import { readSafePositions } from './hedge/positionReader'
import { HedgeTracker } from './hedge/reconcile'
import { assessSafety } from './hedge/safety'
import type { Notifier } from './notify/telegram'
import { formatCycleSummary, formatError, formatSkip } from './presenters/summary'
import { type PriceSignalSource, PriceSignalUnavailableError } from './priceSignal'
import type { RolesExecutor } from './safe/rolesExecutor'
import { botError, botLog, botWarn } from './utils/log'
import { asSdkClient } from './utils/sdkClient'

export interface HedgerBotDeps {
  config: HedgerBotConfig
  publicClient: PublicClient
  account: Account
  priceSource: PriceSignalSource
  executor: HedgeExecutor
  rolesExecutor: RolesExecutor
  notifier: Notifier
  gasPolicy: GasPolicy
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

/**
 * Orchestrates one hedging cycle: read price signal → read Safe positions →
 * safety gate → compute plan → execute via Roles → update hedge tracking →
 * notify. Cycles never overlap (isCycleInFlight gate).
 */
export class HedgerBot {
  private readonly deps: HedgerBotDeps
  private readonly tracker = new HedgeTracker()
  private isCycleInFlight = false
  private lastDispatchTxHash?: Hex

  constructor(deps: HedgerBotDeps) {
    this.deps = deps
  }

  /** One-time startup: verify the Roles modifier is wired to the Safe. */
  async init(): Promise<void> {
    await this.deps.rolesExecutor.preflight()
    await this.deps.notifier.notify('🤖 hedger-bot started')
  }

  async runCycle(trigger: string): Promise<void> {
    if (this.isCycleInFlight) {
      botLog(`[hedger-bot] cycle already in flight; skipping ${trigger}`)
      return
    }
    this.isCycleInFlight = true
    try {
      await this.doCycle(trigger)
    } catch (error) {
      botError(`[hedger-bot] cycle error (${trigger})`, error)
      // Retryable transient RPC/nonce errors: let the next cycle retry silently.
      if (!isRetryableRpcError(error) && !isNonceError(error)) {
        await this.deps.notifier.notify(formatError(trigger, error))
      }
    } finally {
      this.isCycleInFlight = false
    }
  }

  private async doCycle(trigger: string): Promise<void> {
    const { config, publicClient, priceSource, executor, notifier, gasPolicy } = this.deps
    this.deps.recordPoll?.(trigger)
    const poolAddress = config.POOL_ADDRESS
    const safeAddress = config.SAFE_ADDRESS
    const chainId = BigInt(config.CHAIN_ID)

    // Keeper gas-money watchdog — never let a balance check fail the cycle.
    await gasPolicy.checkKeeperBalance().catch((error) => {
      botWarn('[hedger-bot] keeper balance check failed ' + String(error))
    })

    let signal
    try {
      signal = await priceSource.getSignal()
    } catch (error) {
      // Warmup / transient staleness (e.g. cex feeds still connecting at startup)
      // is an expected soft skip — log and wait for the next cycle, don't error.
      if (error instanceof PriceSignalUnavailableError) {
        botLog(`[hedger-bot] price signal unavailable (${trigger}): ${error.message} — skipping`)
        return
      }
      throw error
    }
    botLog(
      `[hedger-bot] signal source=${signal.source} tick=${signal.tick}` +
        (signal.price !== undefined ? ` price=${signal.price}` : '') +
        (signal.detail ? ` ${signal.detail}` : ''),
    )

    const read = await readSafePositions({
      publicClient,
      poolAddress,
      chainId,
      safeAddress,
      trackedHedgeIds: this.tracker.snapshot(),
      lastDispatchTxHash: this.lastDispatchTxHash,
    })
    this.tracker.reconcile(read.positions)
    const hedgePositions = read.positions.filter((p) => this.tracker.has(p.tokenId))
    const openIds = read.positions.map((p) => p.tokenId)

    // Safety gate — never widen risk near liquidation / on a paused pool.
    const pool = await getPool({
      client: asSdkClient<typeof getPool>(publicClient),
      poolAddress,
      chainId,
    })

    // Portfolio snapshot. Margin used = per-position collateral requirement
    // (getFullPositionsData.collateralRequirements), NOT the tracker's locked
    // assets — this matches the /trade page. buyingPower = current − required,
    // the free collateral to open more. Both are the account total cross-
    // converted into each single-token denomination (so [tok0, tok1] are the
    // same value in different units; read whichever numeraire you prefer).
    const bp = await getAccountBuyingPower({
      client: asSdkClient<typeof getAccountBuyingPower>(publicClient),
      poolAddress,
      account: safeAddress,
      tokenIds: openIds,
    })
    const legCount = read.positions.reduce((n, p) => n + p.legs.length, 0)
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
    // Out-of-range = the pool tick is outside a position's option-leg range
    // (width>0). Loans (width=0) have no range and are ignored.
    const outOfRange = read.positions.filter((p) =>
      p.legs.some(
        (leg) =>
          leg.width > 0n && (pool.currentTick < leg.tickLower || pool.currentTick > leg.tickUpper),
      ),
    )
    const oorNote =
      outOfRange.length > 0
        ? ` ⚠️ outOfRange=${outOfRange.length}/${read.positions.length} [${outOfRange
            .map((p) => p.tokenId)
            .join(', ')}]`
        : ''
    botLog(
      `[hedger-bot] portfolio positions=${read.positions.length} legs=${legCount} ` +
        `collateral=[${f0(bp.collateralBalance0)}, ${f1(bp.collateralBalance1)}] ` +
        `buyingPower=[${f0(free0)}, ${f1(free1)}] ` +
        `marginUsed=[${f0(bp.requiredCollateral0)}, ${f1(bp.requiredCollateral1)}]${oorNote}`,
    )

    const safety = await assessSafety({
      publicClient,
      poolAddress,
      safeAddress,
      tokenIds: openIds,
      poolHealthStatus: pool.healthStatus,
    })
    if (!safety.safe) {
      botWarn(`[hedger-bot] unsafe (${trigger}): ${safety.reasons.join('; ')}`)
      await notifier.notify(formatSkip(trigger, safety.reasons))
      return
    }

    // Sanity guard: the price signal must track the pool. A large gap means a
    // misconfigured signal (wrong ASSET_INDEX inverts the cex price, wrong pool,
    // etc.) — dispatching would revert with PriceBoundFail. Skip + alert loudly
    // instead of sending a doomed trade.
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

    const plan = await computeHedgePlan({
      publicClient,
      poolAddress,
      chainId,
      safeAddress,
      signalTick: signal.tick,
      assetIndex: config.ASSET_INDEX as 0n | 1n,
      deltaThresholdBps: config.DELTA_THRESHOLD_BPS,
      absoluteMaxHedgeCount: config.MAX_HEDGE_SLOTS,
      slippageBps: BigInt(config.SLIPPAGE_BPS),
      positions: read.positions,
      hedgePositions,
    })

    const { decimals, symbol } = this.deps.vaultAsset
    const asset = (v: bigint) => `${formatUnits(v, decimals)} ${symbol}`
    botLog(
      `[hedger-bot] ${trigger} action=${plan.action} netDelta=${asset(plan.netDelta)} ` +
        `H=${asset(plan.H)} H*=${asset(plan.Hstar)} drift=${plan.driftBps}bps`,
    )

    if (plan.action === 'none') return

    // Gas deferral gate — hedging is discretionary. Routine hedges wait out
    // basefee spikes; hedges with drift >= URGENT_DRIFT_MULTIPLIER x threshold
    // are urgent and tolerate a much higher basefee. Dry-runs spend no gas
    // and skip the gate so planning stays observable during spikes.
    if (!config.DRY_RUN) {
      const urgent =
        plan.driftBps >= config.DELTA_THRESHOLD_BPS * BigInt(config.URGENT_DRIFT_MULTIPLIER)
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

    const ctx = {
      netDelta: plan.netDelta,
      portfolioSize: plan.portfolioSize,
      sqrtPriceX96: signal.sqrtPriceX96 ?? tickToSqrtPriceX96(signal.tick),
      token0Address: pool.metadata.token0Asset,
      token1Address: pool.metadata.token1Asset,
      collateral0Address: pool.metadata.collateralToken0Address,
      collateral1Address: pool.metadata.collateralToken1Address,
    }
    const result = await executor.execute(plan.intent, ctx)

    // Only a CONFIRMED successful dispatch may mutate hedge tracking. A dry-run
    // or reverted tx left in the tracker would permanently declassify still-open
    // loans as hedges (reconcile only re-seeds when nothing is tracked), and the
    // planner would then hedge against its own hedges.
    if (!result.dryRun) {
      if (result.txHashes.length > 0) {
        const hash = result.txHashes[0]
        this.lastDispatchTxHash = hash
        let receipt
        try {
          receipt = await publicClient.waitForTransactionReceipt({
            hash,
            timeout: config.TX_RECEIPT_TIMEOUT_MS,
          })
        } catch (error) {
          // Stuck/timed-out tx: alert and leave the tracker untouched — the tx
          // may still land, and the next cycle re-reads chain state (the
          // in-flight gate prevented overlap while we waited).
          await notifier.notify(
            formatError(
              trigger,
              new Error(
                `dispatch receipt not seen within ${config.TX_RECEIPT_TIMEOUT_MS}ms: ${hash} — ` +
                  `possibly stuck below basefee; check the keeper's pending txs`,
              ),
            ),
          )
          botError('[hedger-bot] receipt wait failed ' + String(error))
          return
        }
        if (receipt.status !== 'success') {
          await notifier.notify(formatError(trigger, new Error(`dispatch reverted: ${hash}`)))
          return
        }
      }
      this.tracker.applyResult(result.closedTokenIds, result.openedTokenId)
      this.deps.recordHedge?.(plan.action, result.txHashes[0])
    }

    // Same message to the console and Telegram, so an executed hedge is easy to
    // spot in the logs and mirrors the alert exactly.
    const summary = formatCycleSummary(plan, result, trigger, this.deps.vaultAsset)
    botLog(`\n${summary}`)
    await notifier.notify(summary)
  }
}
