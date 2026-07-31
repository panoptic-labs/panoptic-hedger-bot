import {
  type PoolMetadata,
  type StorageAdapter,
  isNonceError,
  isRetryableRpcError,
} from '@panoptic-eng/sdk/v2'
import type { Account, Hex, PublicClient, TransactionReceipt } from 'viem'
import { formatUnits } from 'viem'

import { type HedgerBotConfig, walletWethAddress } from './config'
import { protocolGenesisBlock } from './constants/genesis'
import type {
  CollateralSwapRequest,
  HedgeContext,
  HedgeExecutionResult,
  HedgeExecutor,
  HedgeIntent,
  HedgeSwapRequirement,
} from './executor/types'
import type { GasPolicy } from './gas/gasPolicy'
import { type HedgePlan, computeHedgePlan } from './hedge/decision'
import {
  type DeleverageStage,
  type SelectOptionBurnsResult,
  computeLiquidationBufferBps,
  computeMarginBufferBps,
  DeleverageIncident,
  selectOptionBurns,
} from './hedge/deleverage'
import type { ExecuteWithVenueResult, SfpmSwapExecutorLike } from './hedge/executeWithVenue'
import { executeHedgeWithSfpmVenue } from './hedge/executeWithVenue'
import { computePortfolioDeltaDetailed } from './hedge/frame'
import { type MarginReserveAssessment, assessMarginReserve } from './hedge/marginReserve'
import { assessSafety } from './hedge/safety'
import type { SfpmSwapQuote, SfpmVenueDecision } from './hedge/sfpmVenueCoordinator'
import { isSfpmVenueEligible } from './hedge/sfpmVenueRouter'
import { type HedgeSnapshot, readHedgeSnapshot } from './hedge/snapshot'
import { EMPTY_SAFE_WALLET_BALANCES, spendableAfterCollateralReserve } from './hedge/walletBalances'
import type { Notifier } from './notify/telegram'
import {
  formatCycleSummary,
  formatDeleverageExhausted,
  formatDeleverageSummary,
  formatError,
  formatSkip,
} from './presenters/summary'
import { type PriceSignalSource, PriceSignalUnavailableError } from './priceSignal'
import {
  type HedgeJournalAction,
  type HedgeJournalPort,
  createHedgeRecoveryClient,
} from './runtime/hedgeJournal'
import type { PendingSfpmSwapPort } from './runtime/pendingSfpmSwap'
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
  /**
   * Burn-only executor routed through the deleverager role key. Present only
   * when config.DELEVERAGER_ENABLED — used for Stage 1 (closing user options
   * first). The in-cycle rehedge and the last-resort loan burn reuse the
   * loan-scoped `executor`.
   */
  deleveragerExecutor?: HedgeExecutor
  /**
   * Off-venue SFPM swap venue (present only when config.SFPM_SWAP_ENABLED). For any
   * swapping hedge action, if the SFPM 5bps quote beats the in-pool 30bps swap by the
   * savings threshold, the dispatch runs with swapAtMint=false and the net swap is
   * routed off-venue (two transactions); the coordinator sizes + directs it from the
   * swapAtMint true-vs-false collateral delta.
   */
  sfpmVenue?: {
    coordinator: {
      evaluate(intent: HedgeIntent): Promise<SfpmVenueDecision | null>
      quoteSwap(sellToken0: boolean, amountIn: bigint): Promise<SfpmSwapQuote | null>
    }
    sfpmExecutor: SfpmSwapExecutorLike
  }
  /** Durable tx1→tx2 obligation, read even when the venue is disabled. */
  pendingSwapStore?: PendingSfpmSwapPort
  notifier: Notifier
  gasPolicy: GasPolicy
  hedgeJournal: HedgeJournalPort
  /** Persistence for the SDK position sync (file-backed; survives restarts). */
  storage: StorageAdapter
  /**
   * Immutable pool metadata fetched once at startup — when provided, getPool
   * skips re-reading addresses/decimals/symbols every cycle. Optional (tests);
   * absent just means the SDK refetches it per snapshot.
   */
  poolMetadata?: PoolMetadata
  /**
   * Decimals + symbol of the sizing (vault-asset) token — the frame that
   * netDelta/H/H* are denominated in (config.ASSET_INDEX). Used only to render
   * those amounts as human-readable token quantities in the poll log.
   */
  vaultAsset: { decimals: number; symbol: string }
  /** Heartbeat hooks so a status command can see last poll / last hedge. */
  recordPoll?: (trigger: string) => void
  recordHedge?: (action: string, tx?: Hex) => void
  recordDeleverage?: (
    stage: DeleverageStage,
    bufferBps: bigint,
    tx: Hex | undefined,
    incidentActive: boolean,
  ) => void
}

export type CycleOutcome = 'complete' | 'signal-unavailable' | 'error' | 'in-flight'

interface IntentExecutionResult {
  dispatch: HedgeExecutionResult
  venue: ExecuteWithVenueResult | null
}

type BalanceFirstSwap =
  | {
      route: 'in-pool'
      requirement: HedgeSwapRequirement
      request: CollateralSwapRequest
    }
  | {
      route: 'sfpm'
      requirement: HedgeSwapRequirement
      request: {
        sellToken0: boolean
        kind: 'exactIn'
        amount: bigint
        expectedAmountOut: bigint
        currentTick: number
        positionIdList: bigint[]
      }
    }

type BalanceFirstSwapDecision = BalanceFirstSwap | 'deferred' | null

function successfulReceipt(
  result: { transactionHash: Hex | null; receipt: TransactionReceipt | null },
  label: string,
): TransactionReceipt {
  if (!result.receipt || !result.transactionHash) {
    throw new Error(`live ${label} executor returned without a confirmed transaction receipt`)
  }
  if (result.receipt.status !== 'success') {
    throw new Error(`${label} reverted: ${result.receipt.transactionHash}`)
  }
  return result.receipt
}

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
  private readonly incident?: DeleverageIncident
  private lastWalletRedepositCheckAt = 0

  constructor(deps: HedgerBotDeps) {
    this.deps = deps
    if (deps.config.DELEVERAGER_ENABLED) {
      this.incident = new DeleverageIncident(
        deps.config.DELEVERAGE_TARGET_MARGIN_BPS,
        deps.config.DELEVERAGE_COOLDOWN_MS,
      )
    }
  }

  /** One-time startup: verify the Roles modifier is wired to the Safe. */
  async init(): Promise<void> {
    await this.deps.rolesExecutor.preflight()
    await this.deps.hedgeJournal.recover(createHedgeRecoveryClient(this.deps.publicClient))
    const checkpoint = this.deps.hedgeJournal.checkpoint()
    this.lastDispatchTxHash = checkpoint.transactionHash
    const venue = this.deps.sfpmVenue
    const pending = this.deps.pendingSwapStore?.read()
    if (pending) {
      if (!venue) {
        throw new Error(
          'a pending SFPM swap exists but SFPM_SWAP_ENABLED is false; refusing to plan',
        )
      }
      const swapConfirmed =
        checkpoint.action === 'sfpm_swap' &&
        (pending.swapIntentId === undefined || checkpoint.intentId === pending.swapIntentId)
      const dispatchConfirmed = checkpoint.intentId === pending.dispatchIntentId
      if (swapConfirmed) this.deps.pendingSwapStore?.clear()
      else if (!dispatchConfirmed) {
        // Recovery removed a reverted dispatch journal entry. No imbalance was
        // created, so the pre-dispatch obligation must not be executed.
        this.deps.pendingSwapStore?.clear()
      }
    }
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

    // Uniswap LP tracking is active when hedging is enabled or an extra LP owner
    // is configured (so operators can observe LP delta before flipping the switch).
    const lpTrackingEnabled = config.HEDGE_INCLUDE_LP || Boolean(config.UNISWAP_LP_OWNER)
    const lpOwners = config.UNISWAP_LP_OWNER
      ? [safeAddress, config.UNISWAP_LP_OWNER]
      : [safeAddress]

    // Pinned to the signal's block when it has one; otherwise readHedgeSnapshot
    // resolves head itself (one shared getBlockMeta for all reads).
    const snapshot = await readHedgeSnapshot({
      publicClient,
      poolAddress,
      chainId,
      safeAddress,
      poolMetadata: this.deps.poolMetadata,
      weth9: walletWethAddress(config),
      storage: this.deps.storage,
      fromBlock: config.SYNC_FROM_BLOCK ?? protocolGenesisBlock(config.CHAIN_ID),
      blockNumber: signal.blockNumber,
      lp: lpTrackingEnabled
        ? {
            subgraphUrl: config.LP_SUBGRAPH_URL,
            owners: lpOwners,
            maxLagBlocks: config.LP_SUBGRAPH_MAX_LAG_BLOCKS,
          }
        : undefined,
    })
    if (await this.recoverPendingSfpmSwap(snapshot, trigger)) return
    const { pool, buyingPower: bp } = snapshot
    const walletBalances = snapshot.walletBalances ?? EMPTY_SAFE_WALLET_BALANCES
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
        `safeWallet=[${f0(walletBalances.token0.total)}, ` +
        `${f1(walletBalances.token1.total)}] ` +
        `portfolioCollateral=[${f0(
          snapshot.collateral.token0.assets + walletBalances.token0.total,
        )}, ${f1(snapshot.collateral.token1.assets + walletBalances.token1.total)}] ` +
        `buyingPower=[${f0(free0)}, ${f1(free1)}] ` +
        `marginUsed=[${f0(bp.requiredCollateral0)}, ${f1(bp.requiredCollateral1)}]${oorNote}`,
    )

    const bufferBps = computeLiquidationBufferBps(snapshot.liquidation)
    const safety = assessSafety({
      poolHealthStatus: pool.healthStatus,
      isLiquidatable: snapshot.liquidation.isLiquidatable,
      deleverage: config.DELEVERAGER_ENABLED
        ? {
            enabled: true,
            bufferBps,
            triggerMarginBps: config.DELEVERAGE_TRIGGER_MARGIN_BPS,
          }
        : undefined,
    })
    const hasLooseCollateral = walletBalances.token0.total > 0n || walletBalances.token1.total > 0n
    if (
      safety.verdict !== 'hedge' &&
      hasLooseCollateral &&
      !config.DRY_RUN &&
      (await this.maybeRedepositWalletBalances(trigger, true))
    ) {
      botLog('[hedger-bot] unsafe-state loose collateral was redeposited; replanning next cycle')
      return
    }
    if (safety.verdict === 'deleverage') {
      await this.runDeleverage(trigger, snapshot, bufferBps, safety.paused)
      return
    }
    if (safety.verdict === 'skip') {
      const hint =
        !config.DELEVERAGER_ENABLED && safety.isLiquidatable
          ? [...safety.reasons, 'consider enabling the deleverager to force-close automatically']
          : safety.reasons
      botWarn(`[hedger-bot] unsafe (${trigger}): ${safety.reasons.join('; ')}`)
      await notifier.notify(formatSkip(trigger, hint))
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
      walletBalances,
      signalTick: signal.tick,
      assetIndex: config.ASSET_INDEX as 0n | 1n,
      deltaThresholdBps: config.DELTA_THRESHOLD_BPS,
      deltaOffsetBps: config.DELTA_OFFSET_BPS,
      absoluteMaxHedgeCount: config.MAX_HEDGE_SLOTS,
      slippageBps: BigInt(config.SLIPPAGE_BPS),
      positions: snapshot.positions,
      hedgePositions: snapshot.hedgePositions,
      lpPositions: snapshot.lp?.positions,
      includeLp: config.HEDGE_INCLUDE_LP && (snapshot.lp?.fresh ?? false),
    })
    const balanceFirstSwap = await this.planBalanceFirstSwap(plan, snapshot)

    // Surface the Uniswap LP delta contribution (observed vs applied).
    if (snapshot.lp) {
      const assetDecimals = config.ASSET_INDEX === 0n ? m.token0Decimals : m.token1Decimals
      const assetSymbol = config.ASSET_INDEX === 0n ? m.token0Symbol : m.token1Symbol
      const asset = (v: bigint) => `${formatUnits(v, Number(assetDecimals))} ${assetSymbol}`
      const applied = plan.breakdown.lpIncluded
      if (lpTrackingEnabled && config.HEDGE_INCLUDE_LP && !snapshot.lp.fresh) {
        botWarn(
          `[hedger-bot] Uniswap LP delta NOT applied — subgraph stale ` +
            `(head=${snapshot.lp.headBlock}, chain=${snapshot.blockNumber}); treating LP as observe-only`,
        )
      }
      botLog(
        `[hedger-bot] uniswapLp positions=${snapshot.lp.positions.length} ` +
          `lpDelta=${asset(plan.breakdown.lpDelta)} ${applied ? '(applied)' : '(observed, not applied)'}`,
      )
    }

    if (balanceFirstSwap === 'deferred') return

    if (plan.intent.openTokenId !== null && balanceFirstSwap === null) {
      const margin = await assessFinalStateReserve(
        executor,
        plan.intent,
        snapshot.blockNumber,
        config.MIN_MARGIN_RESERVE_BPS,
      )
      if (!margin.sufficient) {
        if (
          hasLooseCollateral &&
          !config.DRY_RUN &&
          (await this.maybeRedepositWalletBalances(trigger, true))
        ) {
          botLog(
            '[hedger-bot] loose collateral was redeposited for protocol margin; replanning next cycle',
          )
          return
        }
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

    if (plan.action === 'none') {
      await this.maybeRedepositWalletBalances(trigger)
      return
    }

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
    if (balanceFirstSwap !== null) {
      const executed = await this.executeBalanceFirstSwap(balanceFirstSwap, plan, trigger, ctx)
      if (executed) return
      // Preflight rejected the standalone swap (e.g. ExceedsMaximumRedemption
      // when CT liquidity/utilization cannot fund the withdrawal). Fall through
      // to the loan hedge, which needs no collateral withdrawal.
    }
    let execution: IntentExecutionResult
    let activeJournal: HedgeJournalAction | null = null
    let dispatchIntentId: string | null = null
    let pendingPrepared = false
    let dispatchConfirmed = false
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
        dispatchIntentId = this.deps.hedgeJournal.begin(plan.action)
        activeJournal = plan.action
      }
      execution = await this.executeIntent(
        plan.intent,
        ctx,
        (pending) => {
          if (dispatchIntentId === null || !this.deps.sfpmVenue || !this.deps.pendingSwapStore) {
            throw new Error('off-venue dispatch started without durable journal state')
          }
          this.deps.pendingSwapStore.save({
            dispatchIntentId,
            sellToken0: pending.sellToken0,
            amount: pending.amount,
          })
          pendingPrepared = true
        },
        (dispatch) => {
          const receipt = successfulReceipt(dispatch, 'off-venue dispatch')
          dispatchConfirmed = true
          this.lastDispatchTxHash = receipt.transactionHash
          this.deps.hedgeJournal.confirm({
            transactionHash: receipt.transactionHash,
            blockNumber: receipt.blockNumber,
            blockHash: receipt.blockHash,
          })
          activeJournal = null
          const swapIntentId = this.deps.hedgeJournal.begin('sfpm_swap')
          activeJournal = 'sfpm_swap'
          const pending = this.deps.pendingSwapStore?.read()
          if (!pending) throw new Error('durable SFPM swap obligation disappeared after dispatch')
          this.deps.pendingSwapStore?.save({ ...pending, swapIntentId })
        },
      )
    } catch (error) {
      // A receipt timeout is uncertain: one of the observed transactions may
      // still land. Preserve that active intent for startup recovery rather
      // than deleting the only durable identity that can find it.
      const confirmedDispatchNeedsRecovery = dispatchConfirmed && activeJournal === plan.action
      if (
        activeJournal !== null &&
        !(error instanceof TxNotMinedError) &&
        !confirmedDispatchNeedsRecovery
      ) {
        this.deps.hedgeJournal.fail()
        activeJournal = null
      }
      if (pendingPrepared && !dispatchConfirmed && !(error instanceof TxNotMinedError)) {
        this.deps.pendingSwapStore?.clear()
      }
      // The send confirmed nothing within the receipt budget despite fee-bumped
      // replacements. Alert and keep the best-guess hash; the durable pending
      // intent prevents an unsafe duplicate until startup recovery resolves it.
      if (error instanceof TxNotMinedError) {
        this.lastDispatchTxHash = error.lastHash
        botError('[hedger-bot] dispatch not mined', error)
        await notifier.notify(formatError(trigger, error))
        return
      }
      throw error
    }

    const result = execution.dispatch
    // Only confirmed successful transactions may update the recovery journal.
    if (!result.dryRun) {
      const receipt = successfulReceipt(result, 'dispatch')
      this.lastDispatchTxHash = receipt.transactionHash
      if (execution.venue === null) {
        this.deps.hedgeJournal.confirm({
          transactionHash: receipt.transactionHash,
          blockNumber: receipt.blockNumber,
          blockHash: receipt.blockHash,
        })
        activeJournal = null
        this.deps.pendingSwapStore?.clear()
      } else if (execution.venue.swap !== null) {
        const swapReceipt = successfulReceipt(execution.venue.swap, 'off-venue swap')
        this.deps.hedgeJournal.confirm({
          transactionHash: swapReceipt.transactionHash,
          blockNumber: swapReceipt.blockNumber,
          blockHash: swapReceipt.blockHash,
        })
        activeJournal = null
        // The durable obligation is fulfilled; leaving it would make the next
        // cycle's recovery re-execute the full swap against a neutral book.
        this.deps.pendingSwapStore?.clear()
        botLog(`[hedger-bot] off-venue swap confirmed: ${swapReceipt.transactionHash}`)
      } else if (!(execution.venue.swapError instanceof TxNotMinedError)) {
        this.deps.hedgeJournal.fail()
        activeJournal = null
      }
      this.deps.recordHedge?.(plan.action, receipt.transactionHash)
    }

    // Same message to the console and Telegram, so an executed hedge is easy to
    // spot in the logs and mirrors the alert exactly.
    const summary = formatCycleSummary(plan, result, trigger, this.deps.vaultAsset)
    botLog(`\n${summary}`)
    await notifier.notify(summary)
    if (execution.venue?.neutralized !== false) {
      await this.maybeRedepositWalletBalances(trigger)
    }
  }

  /**
   * Prefer owned collateral over a new persistent loan for simple OPEN/GROW
   * hedges. A standalone swap creates the same asset-frame delta as the
   * swapAtMint leg, but consumes available inventory instead of retaining the
   * temporary debt. When inventory covers only part of the required input, the
   * next pinned cycle replans the residual. Shrink/flip/close operations are
   * excluded because their existing-loan burns are part of the transition.
   */
  private async planBalanceFirstSwap(
    plan: HedgePlan,
    snapshot: HedgeSnapshot,
  ): Promise<BalanceFirstSwapDecision> {
    const { intent } = plan
    const executor = this.deps.executor
    if (
      (plan.action !== 'open' && plan.action !== 'grow') ||
      !intent.swapAtMint ||
      intent.openTokenId === null ||
      intent.closeTokenIds.length !== 0 ||
      !executor.deriveSwapRequirement ||
      !executor.simulateCollateralSwap ||
      !executor.executeCollateralSwap
    ) {
      return null
    }

    let requirement: HedgeSwapRequirement | null
    try {
      requirement = await executor.deriveSwapRequirement(intent)
    } catch (error) {
      botWarn(
        `[hedger-bot] balance-first swap sizing failed; retaining loan hedge: ${sanitizeError(error)}`,
      )
      return null
    }
    if (!requirement || requirement.amountIn <= 0n) return null

    const collateralInput =
      requirement.sellTokenType === 0
        ? snapshot.collateral.token0.assets
        : snapshot.collateral.token1.assets
    const walletInput =
      requirement.sellTokenType === 0
        ? snapshot.walletBalances.token0.total
        : snapshot.walletBalances.token1.total
    const totalInput = collateralInput + walletInput
    const spendableInput = spendableAfterCollateralReserve(totalInput)
    if (spendableInput === 0n) return null

    const venue = this.deps.sfpmVenue
    if (venue) {
      try {
        const decision = await venue.coordinator.evaluate(intent)
        if (decision?.use && decision.swapAmount === requirement.amountIn) {
          const amount =
            spendableInput < requirement.amountIn ? spendableInput : requirement.amountIn
          const quote =
            amount === requirement.amountIn
              ? { amountOut: decision.amountOut, swapPoolTick: decision.swapPoolTick }
              : await venue.coordinator.quoteSwap(decision.sellToken0, amount)
          if (quote) {
            return {
              route: 'sfpm',
              requirement,
              request: {
                sellToken0: decision.sellToken0,
                kind: 'exactIn',
                amount,
                expectedAmountOut: quote.amountOut,
                currentTick: quote.swapPoolTick,
                positionIdList: snapshot.positions.map((position) => position.tokenId),
              },
            }
          }
        }
      } catch (error) {
        botWarn(
          `[hedger-bot] balance-first SFPM evaluation failed; considering in-pool: ${sanitizeError(error)}`,
        )
      }
    }

    // The temporary-loan in-pool swap can spend CollateralTracker assets, not
    // loose Safe tokens. When loose inventory is the difference, redeposit it
    // first and let the next pinned snapshot size the swap.
    const spendableCollateral = collateralInput < spendableInput ? collateralInput : spendableInput
    if (spendableCollateral === 0n) {
      if (
        walletInput > 0n &&
        !this.deps.config.DRY_RUN &&
        (await this.maybeRedepositWalletBalances('balance-first', true))
      ) {
        botLog('[hedger-bot] redeposited loose input for an in-pool balance-first swap')
        return 'deferred'
      }
      return null
    }

    const amount =
      spendableCollateral < requirement.amountIn ? spendableCollateral : requirement.amountIn
    return {
      route: 'in-pool',
      requirement,
      request: {
        sellTokenType: requirement.sellTokenType,
        amountIn: amount,
        existingPositionIds: snapshot.positions.map((position) => position.tokenId),
        poolId: snapshot.pool.poolId,
        tickSpacing: BigInt(snapshot.pool.poolKey.tickSpacing),
        currentTick: snapshot.pool.currentTick,
        slippageBps: BigInt(this.deps.config.SLIPPAGE_BPS),
      },
    }
  }

  /**
   * Returns true when the balance-first swap was executed (or dry-run). A
   * preflight simulation failure returns false so the caller falls back to the
   * loan hedge — a persistently unwithdrawable CollateralTracker (high pool
   * utilization → ExceedsMaximumRedemption) must not stall hedging forever.
   */
  private async executeBalanceFirstSwap(
    swap: BalanceFirstSwap,
    plan: HedgePlan,
    trigger: string,
    ctx: HedgeContext,
  ): Promise<boolean> {
    const venue = this.deps.sfpmVenue
    const executor = this.deps.executor
    try {
      if (swap.route === 'sfpm') {
        if (!venue) throw new Error('balance-first SFPM route selected without an executor')
        await venue.sfpmExecutor.simulate(swap.request)
      } else {
        if (!executor.simulateCollateralSwap || !executor.executeCollateralSwap) {
          throw new Error('balance-first in-pool route selected without an executor')
        }
        await executor.simulateCollateralSwap(swap.request)
      }
    } catch (error) {
      botWarn(
        `[hedger-bot] balance-first ${swap.route} swap pre-flight failed; ` +
          `falling back to the loan hedge: ${sanitizeError(error)}`,
      )
      return false
    }

    let journalActive = false
    try {
      if (!this.deps.config.DRY_RUN) {
        this.deps.hedgeJournal.begin('collateral_swap')
        journalActive = true
      }
      const result =
        swap.route === 'sfpm'
          ? await venue?.sfpmExecutor.execute(swap.request)
          : await executor.executeCollateralSwap?.(swap.request, ctx)
      if (!result) throw new Error('balance-first swap executor returned no result')
      if (!result.dryRun) {
        const receipt = successfulReceipt(result, 'balance-first collateral swap')
        this.deps.hedgeJournal.confirm({
          transactionHash: receipt.transactionHash,
          blockNumber: receipt.blockNumber,
          blockHash: receipt.blockHash,
        })
        journalActive = false
        this.lastDispatchTxHash = receipt.transactionHash
        this.deps.recordHedge?.('collateral_swap', receipt.transactionHash)
      }
      const side = swap.requirement.sellTokenType === 0 ? 'token0' : 'token1'
      const amountIn = swap.route === 'sfpm' ? swap.request.amount : swap.request.amountIn
      const message =
        `${this.deps.config.DRY_RUN ? '🟡' : '🟢'} balance-first hedge (${trigger}): ` +
        `sold ${amountIn} ${side} ${swap.route}; ` +
        `no persistent loan opened (planned ${plan.action})`
      botLog(`[hedger-bot] ${message}`)
      await this.deps.notifier.notify(message)
    } catch (error) {
      if (journalActive && !(error instanceof TxNotMinedError)) this.deps.hedgeJournal.fail()
      throw error
    }
    return true
  }

  /**
   * Execute a hedge intent. When the off-venue SFPM swap is configured and this
   * intent is eligible + cheaper there, route it as two transactions (dispatch
   * with swapAtMint=false, then the netting swap in the 5bps pool); otherwise use
   * the in-pool executor unchanged. Returns both transaction results so their
   * independent journal entries can be completed by the cycle orchestrator.
   */
  private async executeIntent(
    intent: HedgeIntent,
    ctx?: HedgeContext,
    beforeDispatch?: (pending: { sellToken0: boolean; amount: bigint }) => void | Promise<void>,
    afterDispatch?: (dispatch: HedgeExecutionResult) => void | Promise<void>,
  ): Promise<IntentExecutionResult> {
    const venue = this.deps.sfpmVenue
    if (venue && isSfpmVenueEligible(intent, { enabled: true })) {
      // A raw RPC/sim error while evaluating the venue must never fail the
      // hedge — fall back to the in-pool executor.
      let decision: SfpmVenueDecision | null = null
      try {
        decision = await venue.coordinator.evaluate(intent)
      } catch (error) {
        botWarn(`[hedger-bot] SFPM venue evaluation failed; using in-pool swap: ${String(error)}`)
      }
      if (decision && !decision.use) {
        botLog('[hedger-bot] SFPM venue: 5bps not cheaper than in-pool by the threshold; in-pool')
      } else if (!decision) {
        botLog('[hedger-bot] SFPM venue: declined (see [sfpm-venue] reason above); in-pool')
      }
      if (decision?.use) {
        // Pre-flight the off-venue MultiSend BEFORE dispatching tx1. A degraded or
        // misconfigured venue (missing Roles scope/unwrapper, thin liquidity,
        // insufficient collateral) must fall back to the in-pool path rather than
        // land tx1 (swapAtMint=false) and then fail tx2, stranding the hedge.
        let venueError: unknown
        try {
          await venue.sfpmExecutor.simulate({
            sellToken0: decision.sellToken0,
            kind: 'exactIn',
            amount: decision.swapAmount,
            expectedAmountOut: decision.amountOut,
            currentTick: decision.swapPoolTick,
            // Preflight runs before tx1, so withdrawal solvency is checked
            // against the Safe's current on-chain position list.
            positionIdList: intent.existingPositionIds,
          })
        } catch (error) {
          venueError = error
        }
        if (venueError !== undefined) {
          botWarn(
            `[hedger-bot] off-venue swap pre-flight failed: ${sanitizeError(venueError)} — ` +
              'using in-pool swap',
          )
          return { dispatch: await this.deps.executor.execute(intent, ctx), venue: null }
        }
        botLog(
          `[hedger-bot] routing hedge swap off-venue (5bps SFPM), ` +
            `sell ${decision.sellToken0 ? 'token0' : 'token1'} amount=${decision.swapAmount}`,
        )
        const res = await executeHedgeWithSfpmVenue({
          dispatchExecutor: this.deps.executor,
          sfpmExecutor: venue.sfpmExecutor,
          intent,
          ctx,
          sellToken0: decision.sellToken0,
          swapAmount: decision.swapAmount,
          expectedAmountOut: decision.amountOut,
          swapPoolTick: decision.swapPoolTick,
          beforeDispatch,
          afterDispatch,
        })
        if (!res.neutralized) {
          if (res.swapError instanceof TxNotMinedError) {
            botError(
              '[hedger-bot] off-venue swap not confirmed before timeout — pending journal preserved for startup recovery',
              res.swapError,
            )
            await this.deps.notifier.notify(
              '⚠️ off-venue SFPM swap is still unconfirmed; restart the bot to recover the pending transaction before another hedge',
            )
          } else {
            botError(
              '[hedger-bot] off-venue swap FAILED after dispatch landed — book un-neutralized until next cycle',
              res.swapError,
            )
            await this.deps.notifier.notify(
              '⚠️ off-venue SFPM swap failed after the hedge dispatch; delta is un-neutralized until the next cycle',
            )
          }
        }
        return { dispatch: res.dispatch, venue: res }
      }
    }
    return { dispatch: await this.deps.executor.execute(intent, ctx), venue: null }
  }

  /**
   * Finish a previously confirmed off-venue dispatch before any new planning.
   * The exact-input obligation is durable; only its quote/tick and live
   * position list are refreshed. A failure keeps the obligation and blocks a
   * second hedge.
   */
  private async recoverPendingSfpmSwap(snapshot: HedgeSnapshot, trigger: string): Promise<boolean> {
    const venue = this.deps.sfpmVenue
    if (!venue) return false
    const store = this.deps.pendingSwapStore
    if (!store) return false
    const pending = store.read()
    if (!pending) return false

    const quote = await venue.coordinator.quoteSwap(pending.sellToken0, pending.amount)
    if (!quote) {
      throw new Error('pending SFPM swap cannot be quoted; refusing to plan another hedge')
    }
    const request = {
      sellToken0: pending.sellToken0,
      kind: 'exactIn' as const,
      amount: pending.amount,
      expectedAmountOut: quote.amountOut,
      currentTick: quote.swapPoolTick,
      positionIdList: snapshot.positions.map((position) => position.tokenId),
    }
    await venue.sfpmExecutor.simulate(request)

    let journalActive = false
    let confirmedReceiptSeen = false
    try {
      const swapIntentId = this.deps.hedgeJournal.begin('sfpm_swap')
      journalActive = true
      store.save({ ...pending, swapIntentId })
      const result = await venue.sfpmExecutor.execute(request)
      const receipt = successfulReceipt(result, 'pending off-venue swap')
      confirmedReceiptSeen = true
      this.deps.hedgeJournal.confirm({
        transactionHash: receipt.transactionHash,
        blockNumber: receipt.blockNumber,
        blockHash: receipt.blockHash,
      })
      journalActive = false
      store.clear()
      botLog(`[hedger-bot] recovered pending off-venue swap: ${receipt.transactionHash}`)
      await this.deps.notifier.notify(
        `✅ recovered pending off-venue SFPM swap (${trigger}): ${receipt.transactionHash}`,
      )
    } catch (error) {
      if (journalActive && !(error instanceof TxNotMinedError) && !confirmedReceiptSeen) {
        this.deps.hedgeJournal.fail()
      }
      throw error
    }
    return true
  }

  /**
   * Periodic best-effort maintenance. Loose balances are already included in
   * economic delta, so a failed redeposit cannot trigger a duplicate hedge.
   * Protocol margin remains the on-chain CT balance until this transaction lands.
   */
  private async maybeRedepositWalletBalances(trigger: string, force = false): Promise<boolean> {
    const venue = this.deps.sfpmVenue
    if (!venue) return false
    const now = Date.now()
    if (!force && now - this.lastWalletRedepositCheckAt < 15 * 60_000) return false
    this.lastWalletRedepositCheckAt = now

    let balances
    try {
      balances = await venue.sfpmExecutor.readWalletBalances()
    } catch (error) {
      botWarn(`[hedger-bot] loose collateral balance read failed: ${sanitizeError(error)}`)
      return false
    }
    if (balances.token0.total === 0n && balances.token1.total === 0n) return false
    if (this.deps.config.DRY_RUN) {
      await venue.sfpmExecutor.redepositWalletBalances()
      botLog('[hedger-bot] dry-run: loose Safe collateral redeposit simulation succeeded')
      return false
    }

    let journalActive = false
    try {
      this.deps.hedgeJournal.begin('wallet_redeposit')
      journalActive = true
      const result = await venue.sfpmExecutor.redepositWalletBalances()
      const receipt = successfulReceipt(result, 'wallet redeposit')
      this.deps.hedgeJournal.confirm({
        transactionHash: receipt.transactionHash,
        blockNumber: receipt.blockNumber,
        blockHash: receipt.blockHash,
      })
      journalActive = false
      botLog(
        `[hedger-bot] redeposited loose Safe collateral (${trigger}): ${receipt.transactionHash}`,
      )
      return true
    } catch (error) {
      if (journalActive && !(error instanceof TxNotMinedError)) this.deps.hedgeJournal.fail()
      botWarn(`[hedger-bot] loose collateral redeposit failed: ${sanitizeError(error)}`)
      return false
    }
  }

  /** Build a burn-only intent (no mint) for the current open position set. */
  private buildBurnIntent(
    action: 'deleverage_loans' | 'deleverage_options',
    closeTokenIds: bigint[],
    snapshot: HedgeSnapshot,
  ): HedgeIntent {
    return {
      action,
      openTokenId: null,
      openPositionSize: null,
      // Burning ITM options swaps in-pool, so use the (wider) deleverage band.
      swapAtMint: true,
      closeTokenIds,
      existingPositionIds: snapshot.positions.map((p) => p.tokenId),
      skippedCollidingTokenIds: [],
      currentTick: snapshot.pool.currentTick,
      slippageBps: BigInt(this.deps.config.DELEVERAGE_SLIPPAGE_BPS),
    }
  }

  /**
   * Execute a single burn-only stage through the given executor: journal +
   * urgent send (no gas deferral gate), or simulate in dry-run. Returns the
   * confirmed tx hash (undefined in dry-run) or throws.
   */
  private async executeBurnStage(
    executor: HedgeExecutor,
    intent: HedgeIntent,
  ): Promise<Hex | undefined> {
    const { config } = this.deps
    if (config.DRY_RUN) {
      await executor.execute(intent, { urgent: true })
      return undefined
    }
    if (intent.action === 'none') throw new Error('cannot execute a no-op burn stage')
    this.deps.hedgeJournal.begin(intent.action)
    let result
    try {
      result = await executor.execute(intent, { urgent: true })
    } catch (error) {
      if (error instanceof TxNotMinedError) this.lastDispatchTxHash = error.lastHash
      else this.deps.hedgeJournal.fail()
      throw error
    }
    const receipt = result.receipt
    if (!receipt || !result.transactionHash) {
      this.deps.hedgeJournal.fail()
      throw new Error('live deleverage executor returned without a confirmed receipt')
    }
    this.lastDispatchTxHash = receipt.transactionHash
    if (receipt.status !== 'success') {
      this.deps.hedgeJournal.fail()
      throw new Error(`deleverage dispatch reverted: ${receipt.transactionHash}`)
    }
    this.deps.hedgeJournal.confirm({
      transactionHash: receipt.transactionHash,
      blockNumber: receipt.blockNumber,
      blockHash: receipt.blockHash,
    })
    return receipt.transactionHash
  }

  /** Re-read the account and re-observe the incident; returns fresh state. */
  private async reassess(
    trigger: string,
  ): Promise<{ snapshot: HedgeSnapshot; bufferBps: bigint; stillTriggered: boolean }> {
    const snapshot = await this.readSnapshot(trigger)
    const bufferBps = computeLiquidationBufferBps(snapshot.liquidation)
    const stillTriggered = this.incident
      ? this.incident.observe({
          isLiquidatable: snapshot.liquidation.isLiquidatable,
          bufferBps,
          triggerMarginBps: this.deps.config.DELEVERAGE_TRIGGER_MARGIN_BPS,
        })
      : false
    return { snapshot, bufferBps, stillTriggered }
  }

  /** Option positions currently held (everything that isn't a bot hedge loan). */
  private optionPositions(snapshot: HedgeSnapshot): HedgeSnapshot['positions'] {
    return snapshot.positions.filter(
      (p) => !snapshot.hedgePositions.some((h) => h.tokenId === p.tokenId),
    )
  }

  /**
   * Recompute the hedge plan on a reduced book (with `burnedOptionIds` removed).
   * Marks delta at pool spot and uses the wider deleverage band. Pure w.r.t the
   * chain — `computeHedgePlan` derives everything from the position list.
   */
  private computeRehedgePlan(snapshot: HedgeSnapshot, burnedOptionIds: bigint[]): HedgePlan {
    const { config } = this.deps
    const removed = new Set(burnedOptionIds)
    return computeHedgePlan({
      pool: snapshot.pool,
      collateral: snapshot.collateral,
      walletBalances: snapshot.walletBalances,
      signalTick: snapshot.pool.currentTick,
      assetIndex: config.ASSET_INDEX as 0n | 1n,
      deltaThresholdBps: config.DELTA_THRESHOLD_BPS,
      deltaOffsetBps: config.DELTA_OFFSET_BPS,
      absoluteMaxHedgeCount: config.MAX_HEDGE_SLOTS,
      slippageBps: BigInt(config.DELEVERAGE_SLIPPAGE_BPS),
      positions: snapshot.positions.filter((p) => !removed.has(p.tokenId)),
      hedgePositions: snapshot.hedgePositions.filter((p) => !removed.has(p.tokenId)),
    })
  }

  /**
   * One atomic intent that burns the candidate options AND applies the rehedge
   * computed on the reduced book (burn now-oversized loans, mint the one new
   * loan). `buildItems` orders burns before the mint, so freed margin covers the
   * mint. Used to SIMULATE the true close+rehedge impact for ranking; execution
   * still splits across the deleverager role (options) and the loan role
   * (rehedge), since a single tx can't span both Zodiac role keys.
   */
  private buildCompositeCloseRehedgeIntent(
    snapshot: HedgeSnapshot,
    burnedOptionIds: bigint[],
    rehedge: HedgePlan,
  ): HedgeIntent {
    return {
      action: 'deleverage_options',
      openTokenId: rehedge.intent.openTokenId,
      openPositionSize: rehedge.intent.openPositionSize,
      swapAtMint: true,
      closeTokenIds: [...burnedOptionIds, ...rehedge.intent.closeTokenIds],
      existingPositionIds: snapshot.positions.map((p) => p.tokenId),
      skippedCollidingTokenIds: rehedge.intent.skippedCollidingTokenIds,
      currentTick: snapshot.pool.currentTick,
      slippageBps: BigInt(this.deps.config.DELEVERAGE_SLIPPAGE_BPS),
    }
  }

  /**
   * Rank + select the option burn subset for one deleverage iteration. The
   * simulator models CLOSE + REHEDGE (not the bare option burn) so ranking
   * reflects the true health impact — closing a large-|delta| option unwinds the
   * most hedge loans. Candidates are pre-sorted by |delta| so the biggest-impact
   * closes are tried first. Extracted so its closures don't capture loop state.
   */
  private selectOptionBurnsFor(
    deleveragerExecutor: HedgeExecutor,
    snapshot: HedgeSnapshot,
  ): Promise<SelectOptionBurnsResult> {
    const { config } = this.deps
    const assetIndex = config.ASSET_INDEX as 0n | 1n
    const breakdown = computePortfolioDeltaDetailed(
      snapshot.positions,
      snapshot.pool.currentTick,
      BigInt(snapshot.pool.poolKey.tickSpacing),
      assetIndex,
    )
    const absDeltaById = new Map<bigint, bigint>(
      breakdown.positions.map((p) => [p.tokenId, p.total < 0n ? -p.total : p.total]),
    )
    const candidates = this.optionPositions(snapshot).map((p) => ({
      tokenId: p.tokenId,
      absDelta: absDeltaById.get(p.tokenId) ?? 0n,
    }))
    const blockNumber = snapshot.blockNumber
    return selectOptionBurns({
      candidates,
      targetMarginBps: config.DELEVERAGE_TARGET_MARGIN_BPS,
      simulate: async (tokenIds) => {
        const rehedge = this.computeRehedgePlan(snapshot, tokenIds)
        const composite = this.buildCompositeCloseRehedgeIntent(snapshot, tokenIds, rehedge)
        const preview = await deleveragerExecutor.previewFinalState(composite, blockNumber)
        return preview.success ? computeMarginBufferBps(preview.margin) : null
      },
    })
  }

  /**
   * Emergency de-risking. Options are the risk/margin driver, so we close them
   * FIRST (burn-only deleverager role) — burning the hedge loans first would
   * strip the delta hedge and leave the book MORE exposed. Immediately after each
   * option burn we RE-HEDGE the freed delta in-cycle (loan role) so the simulated
   * post-rehedge health is actually realized this cycle. Burning the bot's own
   * hedge loans outright is only a last-resort fallback when there are no options
   * left to close and the account is still at risk. Everything runs urgent and
   * skips the basefee deferral — a liquidation penalty dwarfs gas.
   *
   * Runs even while the pool is paused (safe-mode is burn/close-only, so burns
   * land); only a rehedge that would MINT is skipped while paused.
   */
  private async runDeleverage(
    trigger: string,
    snapshot: HedgeSnapshot,
    bufferBps: bigint,
    paused: boolean,
  ): Promise<void> {
    const { config, executor, notifier } = this.deps
    const nowMs = Date.now()
    this.incident?.observe({
      isLiquidatable: snapshot.liquidation.isLiquidatable,
      bufferBps,
      triggerMarginBps: config.DELEVERAGE_TRIGGER_MARGIN_BPS,
    })
    botWarn(
      `[hedger-bot] DELEVERAGE triggered (${trigger}): buffer=${bufferBps}bps ` +
        `trigger=${config.DELEVERAGE_TRIGGER_MARGIN_BPS}bps ` +
        `liquidatable=${snapshot.liquidation.isLiquidatable} paused=${paused}`,
    )

    // ---- Stage 1 (primary): close options (deleverager role) + in-cycle rehedge
    // (loan role). Loop: pick the close+rehedge-ranked subset, burn, rehedge,
    // re-assess, and keep going while eligible options remain and the account is
    // still at risk. Only when no eligible option burns are left do we fall
    // through to burning the bot's own loans.
    const deleveragerExecutor = this.deps.deleveragerExecutor
    const canRunOptions = this.incident?.canRunStage('options', nowMs) ?? true
    if (deleveragerExecutor && canRunOptions) {
      let markedStage = false
      // Guard against a non-progressing loop by requiring the option set to shrink.
      let previousCount = Number.POSITIVE_INFINITY
      while (true) {
        const remaining = this.optionPositions(snapshot)
        if (remaining.length === 0 || remaining.length >= previousCount) break
        previousCount = remaining.length

        const selection = await this.selectOptionBurnsFor(deleveragerExecutor, snapshot)
        if (selection.tokenIds.length === 0) break

        const burnIntent = this.buildBurnIntent('deleverage_options', selection.tokenIds, snapshot)
        const tx = await this.executeBurnStage(deleveragerExecutor, burnIntent)
        if (!markedStage) {
          this.incident?.markStageRun('options', nowMs)
          markedStage = true
        }
        this.deps.recordDeleverage?.('options', bufferBps, tx, this.incident?.active ?? false)
        const msg = formatDeleverageSummary({
          label: trigger,
          stage: 'options',
          dryRun: config.DRY_RUN,
          bufferBps,
          triggerMarginBps: config.DELEVERAGE_TRIGGER_MARGIN_BPS,
          burnedTokenIds: selection.tokenIds,
          transactionHash: tx ?? null,
          projectedBufferBps: selection.projectedBufferBps,
          burnedAll: selection.burnedAll,
        })
        botLog(`\n${msg}`)
        await notifier.notify(msg)
        if (config.DRY_RUN) return

        // In-cycle rehedge: re-neutralize the delta freed by the option burn so
        // the now-oversized loans shrink now, not next poll.
        await this.runInCycleRehedge(trigger, paused)

        const after = await this.reassess(trigger)
        if (!after.stillTriggered) {
          botLog(`[hedger-bot] deleverage: margin buffer recovered to ${after.bufferBps}bps`)
          return
        }
        snapshot = after.snapshot
        bufferBps = after.bufferBps
      }
    }

    // ---- Stage 2 (fallback): relieve margin by burning the bot's own hedge ---
    // loans via the loan role. Only reached when options couldn't clear the risk
    // (none left, no deleverager role, or still at risk after closing them).
    const loanIds = snapshot.hedgePositions.map((p) => p.tokenId)
    if (loanIds.length > 0 && (this.incident?.canRunStage('loans', nowMs) ?? true)) {
      const intent = this.buildBurnIntent('deleverage_loans', loanIds, snapshot)
      const tx = await this.executeBurnStage(executor, intent)
      this.incident?.markStageRun('loans', nowMs)
      this.deps.recordDeleverage?.('loans', bufferBps, tx, this.incident?.active ?? false)
      const msg = formatDeleverageSummary({
        label: trigger,
        stage: 'loans',
        dryRun: config.DRY_RUN,
        bufferBps,
        triggerMarginBps: config.DELEVERAGE_TRIGGER_MARGIN_BPS,
        burnedTokenIds: loanIds,
        transactionHash: tx ?? null,
      })
      botLog(`\n${msg}`)
      await notifier.notify(msg)
      if (config.DRY_RUN) return
      const after = await this.reassess(trigger)
      if (after.stillTriggered) {
        await notifier.notify(formatDeleverageExhausted(trigger, after.bufferBps))
      }
      return
    }

    // Nothing left to burn but still at risk.
    await notifier.notify(formatDeleverageExhausted(trigger, bufferBps))
  }

  /**
   * Re-neutralize delta on the current (post-option-burn) book via the loan role,
   * urgent and un-gated. Skipped when the plan would MINT while the pool is paused
   * (safe-mode blocks mints); pure loan-shrinking burns still proceed while paused.
   */
  private async runInCycleRehedge(trigger: string, paused: boolean): Promise<void> {
    const { config, executor, notifier } = this.deps
    const fresh = await this.readSnapshot(trigger)
    const plan = this.computeRehedgePlan(fresh, [])
    if (
      plan.action === 'none' ||
      (plan.intent.openTokenId === null && plan.intent.closeTokenIds.length === 0)
    ) {
      return
    }
    if (paused && plan.intent.openTokenId !== null) {
      botWarn(
        `[hedger-bot] deleverage rehedge deferred (${trigger}): pool paused — cannot mint a hedge loan`,
      )
      await notifier.notify(
        formatSkip(trigger, ['pool paused (close-only): rehedge mint deferred until unpaused']),
      )
      return
    }
    const tx = await this.executeBurnStage(executor, plan.intent)
    const adjusted = [
      ...plan.intent.closeTokenIds,
      ...(plan.intent.openTokenId !== null ? [plan.intent.openTokenId] : []),
    ]
    const msg = formatDeleverageSummary({
      label: trigger,
      stage: 'rehedge',
      dryRun: config.DRY_RUN,
      bufferBps: computeLiquidationBufferBps(fresh.liquidation),
      triggerMarginBps: config.DELEVERAGE_TRIGGER_MARGIN_BPS,
      burnedTokenIds: adjusted,
      transactionHash: tx ?? null,
    })
    botLog(`\n${msg}`)
    await notifier.notify(msg)
  }

  /** Read a fresh block-pinned snapshot (used for mid-deleverage re-assessment). */
  private async readSnapshot(_trigger: string): Promise<HedgeSnapshot> {
    const { config, publicClient } = this.deps
    // No explicit pin block: readHedgeSnapshot resolves head once via its own
    // shared getBlockMeta and pins every read to it.
    return readHedgeSnapshot({
      publicClient,
      poolAddress: config.POOL_ADDRESS,
      chainId: BigInt(config.CHAIN_ID),
      safeAddress: config.SAFE_ADDRESS,
      poolMetadata: this.deps.poolMetadata,
      weth9: walletWethAddress(config),
      storage: this.deps.storage,
      fromBlock: config.SYNC_FROM_BLOCK ?? protocolGenesisBlock(config.CHAIN_ID),
    })
  }
}
