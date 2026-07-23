import { createMemoryStorage, getPoolMetadata } from '@panoptic-eng/sdk/v2'
import { formatEther, formatUnits } from 'viem'

import { protocolGenesisBlock } from '../../../src/constants/genesis'
import { computeHedgePlan } from '../../../src/hedge/decision'
import { readHedgeSnapshot } from '../../../src/hedge/snapshot'
import { createPriceSignalSource } from '../../../src/priceSignal'
import { resolveCexAssetOrientation } from '../../../src/priceSignal/cexSource'
import { buildActivationEvidence, isActivated } from '../../../src/runtime/activation'
import { botVersion, computeRunning, readRuntimeState } from '../../../src/runtime/stateFile'
import { botWarn } from '../../../src/utils/log'
import { sanitizeError } from '../../../src/utils/sanitize'
import { asSdkClient } from '../../../src/utils/sdkClient'
import { isModuleEnabled, readSafeOwners } from '../existingSafe'
import { verifyLoanOnlyScope } from '../verifyScope'
import type { StatusDiagnosticsContext } from './context'

export interface StatusSnapshot {
  version: string
  running: string
  readiness: string
  runningMode?: 'live' | 'dry-run'
  nextStartMode: 'live' | 'dry-run'
  chainId: number
  pool: string
  poolPair?: string
  safe: string
  safeOwners?: string
  botAddress?: string
  botBalanceEth?: string
  moduleEnabled?: boolean
  loanOnlyScope?: 'ok' | 'FAILED' | 'unknown'
  positions?: string
  netDelta?: string
  /** Uniswap LP summary (owner scope, count, subgraph lag/freshness, delta); undefined when LP tracking is off. */
  lp?: string
  priceSignal?: string
  lastPoll?: string
  lastHedge?: string
  deleverager?: string
  notes: string[]
}

function fmtAgo(iso?: string): string {
  if (!iso) return 'never'
  const s = Math.round((Date.now() - Date.parse(iso)) / 1000)
  return `${s}s ago`
}

/** Best-effort operator snapshot. Individual read failures degrade gracefully. */
export async function gatherStatus(ctx: StatusDiagnosticsContext): Promise<StatusSnapshot> {
  const { config, publicClient, botAddress } = ctx
  const notes: string[] = []
  const state = readRuntimeState()
  const run = computeRunning(state, config.POLL_INTERVAL_MS)
  const evidence = await (async () => {
    if (!botAddress || config.CHAIN_ID !== 1 || config.HEDGE_VENUE !== 'in-pool') return undefined
    return buildActivationEvidence(publicClient, config)
  })().catch((error) => {
    botWarn(`[hedger-bot] activation evidence unavailable: ${sanitizeError(error)}`)
    return undefined
  })
  const activated = isActivated(config, botAddress, evidence)
  const effectiveDryRun = config.DRY_RUN || !activated
  const stateIdentityMatches =
    state?.chainId === config.CHAIN_ID &&
    state.safe.toLowerCase() === config.SAFE_ADDRESS.toLowerCase() &&
    state.pool.toLowerCase() === config.POOL_ADDRESS.toLowerCase() &&
    state.version === botVersion()
  const runningMode =
    run.running && stateIdentityMatches ? (state.dryRun ? 'dry-run' : 'live') : undefined

  const snap: StatusSnapshot = {
    version: botVersion(),
    running: run.running ? `running (${run.reason})` : `not running (${run.reason})`,
    readiness: stateIdentityMatches
      ? `${state.ready ? 'ready' : 'not ready'} (${state.lifecycle})`
      : 'unknown (untrusted heartbeat)',
    runningMode,
    nextStartMode: effectiveDryRun ? 'dry-run' : 'live',
    chainId: config.CHAIN_ID,
    pool: config.POOL_ADDRESS,
    safe: config.SAFE_ADDRESS,
    botAddress,
    lastPoll: state?.lastPollAt
      ? `${fmtAgo(state.lastPollAt)} (${state.lastPollTrigger ?? '?'})`
      : 'never',
    lastHedge: state?.lastHedgeAt
      ? `${fmtAgo(state.lastHedgeAt)} (${state.lastHedgeAction ?? '?'}${state.lastHedgeTx ? ` ${state.lastHedgeTx}` : ''})`
      : 'never',
    deleverager: !config.DELEVERAGER_ENABLED
      ? 'disabled'
      : stateIdentityMatches && state?.lastDeleverageAt
        ? `enabled — last ${fmtAgo(state.lastDeleverageAt)} (${state.lastDeleverageStage ?? '?'}` +
          `${
            (state.lastBufferBps ?? state.lastMinReserveBps) !== undefined
              ? `, buffer ${state.lastBufferBps ?? state.lastMinReserveBps}bps`
              : ''
          }` +
          `${state.deleverageIncidentActive ? ', INCIDENT ACTIVE' : ''})`
        : 'enabled — no incidents',
    notes,
  }
  if (!activated && !config.DRY_RUN)
    notes.push('not activated — start would force dry-run (run `pnpm activate`)')
  if (state && !stateIdentityMatches)
    notes.push('runtime heartbeat identity/version mismatch — ignored')
  if (runningMode && runningMode !== (effectiveDryRun ? 'dry-run' : 'live')) {
    notes.push(
      `running mode is ${runningMode}; next start would be ${effectiveDryRun ? 'dry-run' : 'live'}`,
    )
  }

  try {
    const md = await getPoolMetadata({
      client: asSdkClient<typeof getPoolMetadata>(publicClient),
      poolAddress: config.POOL_ADDRESS,
    })
    snap.poolPair = `${md.token0Symbol}/${md.token1Symbol}`

    if (botAddress) {
      snap.botBalanceEth = formatEther(await publicClient.getBalance({ address: botAddress }))
    }
    snap.safeOwners = (await readSafeOwners(publicClient, config.SAFE_ADDRESS)).join(', ')
    snap.moduleEnabled = await isModuleEnabled(
      publicClient,
      config.SAFE_ADDRESS,
      config.ROLES_MODIFIER_ADDRESS,
    )

    if (botAddress) {
      try {
        await verifyLoanOnlyScope({
          publicClient,
          rolesModifierAddress: config.ROLES_MODIFIER_ADDRESS,
          botAddress,
          roleKey: config.ROLE_KEY,
          poolAddress: config.POOL_ADDRESS,
          poolId: md.poolId,
          log: () => {},
        })
        snap.loanOnlyScope = 'ok'
      } catch {
        snap.loanOnlyScope = 'FAILED'
      }
    } else {
      snap.loanOnlyScope = 'unknown'
    }

    const snapshot = await readHedgeSnapshot({
      publicClient,
      poolAddress: config.POOL_ADDRESS,
      chainId: BigInt(config.CHAIN_ID),
      safeAddress: config.SAFE_ADDRESS,
      storage: createMemoryStorage(),
      fromBlock: config.SYNC_FROM_BLOCK ?? protocolGenesisBlock(config.CHAIN_ID),
      lp:
        config.HEDGE_INCLUDE_LP || config.UNISWAP_LP_OWNER
          ? {
              subgraphUrl: config.LP_SUBGRAPH_URL,
              owners: config.UNISWAP_LP_OWNER
                ? [config.SAFE_ADDRESS, config.UNISWAP_LP_OWNER]
                : [config.SAFE_ADDRESS],
              maxLagBlocks: config.LP_SUBGRAPH_MAX_LAG_BLOCKS,
            }
          : undefined,
    })
    const hedgeCount = snapshot.hedgePositions.length
    snap.positions = `${snapshot.positions.length} open (${hedgeCount} hedge loan${
      hedgeCount === 1 ? '' : 's'
    })`

    // Price signal (best-effort; falls back to pool tick for the delta calc).
    const ethTokenIndex =
      config.PRICE_SIGNAL_SOURCE === 'cex'
        ? resolveCexAssetOrientation(config.CHAIN_ID, md.token0Asset, md.token1Asset)
        : undefined
    let signalTick = snapshot.pool.currentTick
    const source = createPriceSignalSource(config, {
      publicClient,
      token0Decimals: BigInt(md.token0Decimals),
      token1Decimals: BigInt(md.token1Decimals),
      ethTokenIndex,
    })
    try {
      const signal = await source.getSignal()
      signalTick = signal.tick
      const ageS = Math.round((Date.now() - signal.observedAtMs) / 1000)
      snap.priceSignal = `${signal.source} tick=${signal.tick} (${ageS}s old)${signal.price !== undefined ? ` ~$${signal.price}` : ''}`
    } catch (err) {
      snap.priceSignal = `unavailable: ${sanitizeError(err)}`
    } finally {
      source.stop?.()
    }

    const plan = computeHedgePlan({
      pool: snapshot.pool,
      collateral: snapshot.collateral,
      signalTick,
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
    const dec = config.ASSET_INDEX === 0n ? Number(md.token0Decimals) : Number(md.token1Decimals)
    const sym = config.ASSET_INDEX === 0n ? md.token0Symbol : md.token1Symbol
    snap.netDelta = `${formatUnits(plan.netDelta, dec)} ${sym} (drift ${plan.driftBps}bps, action ${plan.action})`

    // Uniswap LP: only when tracking is configured (snapshot.lp is present).
    if (snapshot.lp) {
      const lp = snapshot.lp
      const lag = snapshot.blockNumber > lp.headBlock ? snapshot.blockNumber - lp.headBlock : 0n
      const owners = config.UNISWAP_LP_OWNER ? `Safe + ${config.UNISWAP_LP_OWNER}` : 'Safe'
      const freshness = lp.fresh ? 'fresh' : 'STALE'
      const mode = plan.breakdown.lpIncluded ? 'applied' : 'observed'
      snap.lp =
        `${lp.positions.length} pos [${owners}], ` +
        `head=${lp.headBlock} lag=${lag} (${freshness}), ` +
        `Δ ${formatUnits(plan.breakdown.lpDelta, dec)} ${sym} (${mode})`
    }
  } catch (err) {
    notes.push(`on-chain read failed: ${sanitizeError(err)}`)
  }

  return snap
}
