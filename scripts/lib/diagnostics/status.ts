import { getPool, getPoolMetadata } from '@panoptic-eng/sdk/v2'
import { formatEther, formatUnits } from 'viem'

import { computeHedgePlan } from '../../../src/hedge/decision'
import { readSafePositions } from '../../../src/hedge/positionReader'
import { createPriceSignalSource } from '../../../src/priceSignal'
import { isActivated } from '../../../src/runtime/activation'
import { botVersion, computeRunning, readRuntimeState } from '../../../src/runtime/stateFile'
import { asSdkClient } from '../../../src/utils/sdkClient'
import { isModuleEnabled, readSafeOwners } from '../existingSafe'
import { verifyLoanOnlyScope } from '../verifyScope'
import type { DiagnosticsContext } from './context'

const STABLES = new Set(['USDC', 'USDT', 'DAI', 'USDC.E', 'USDBC', 'FRAX', 'LUSD', 'GUSD'])

export interface StatusSnapshot {
  version: string
  running: string
  mode: 'live' | 'dry-run'
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
  priceSignal?: string
  lastPoll?: string
  lastHedge?: string
  notes: string[]
}

function fmtAgo(iso?: string): string {
  if (!iso) return 'never'
  const s = Math.round((Date.now() - Date.parse(iso)) / 1000)
  return `${s}s ago`
}

/** Best-effort operator snapshot. Individual read failures degrade gracefully. */
export async function gatherStatus(ctx: DiagnosticsContext): Promise<StatusSnapshot> {
  const { config, publicClient, account } = ctx
  const notes: string[] = []
  const state = readRuntimeState()
  const run = computeRunning(state, config.POLL_INTERVAL_MS)
  const activated = isActivated(config)
  const effectiveDryRun = config.DRY_RUN || !activated

  const snap: StatusSnapshot = {
    version: botVersion(),
    running: run.running ? `running (${run.reason})` : `not running (${run.reason})`,
    mode: effectiveDryRun ? 'dry-run' : 'live',
    chainId: config.CHAIN_ID,
    pool: config.POOL_ADDRESS,
    safe: config.SAFE_ADDRESS,
    botAddress: account?.address,
    lastPoll: state?.lastPollAt
      ? `${fmtAgo(state.lastPollAt)} (${state.lastPollTrigger ?? '?'})`
      : 'never',
    lastHedge: state?.lastHedgeAt
      ? `${fmtAgo(state.lastHedgeAt)} (${state.lastHedgeAction ?? '?'}${state.lastHedgeTx ? ` ${state.lastHedgeTx}` : ''})`
      : 'never',
    notes,
  }
  if (!activated && !config.DRY_RUN)
    notes.push('not activated — start would force dry-run (run `pnpm activate`)')

  try {
    const md = await getPoolMetadata({
      client: asSdkClient<typeof getPoolMetadata>(publicClient),
      poolAddress: config.POOL_ADDRESS,
    })
    snap.poolPair = `${md.token0Symbol}/${md.token1Symbol}`

    if (account) {
      snap.botBalanceEth = formatEther(await publicClient.getBalance({ address: account.address }))
    }
    snap.safeOwners = (await readSafeOwners(publicClient, config.SAFE_ADDRESS)).join(', ')
    snap.moduleEnabled = await isModuleEnabled(
      publicClient,
      config.SAFE_ADDRESS,
      config.ROLES_MODIFIER_ADDRESS,
    )

    if (account) {
      try {
        await verifyLoanOnlyScope({
          publicClient,
          rolesModifierAddress: config.ROLES_MODIFIER_ADDRESS,
          botAddress: account.address,
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

    // Positions + net delta (read-only; computeHedgePlan does no execution).
    const pool = await getPool({
      client: asSdkClient<typeof getPool>(publicClient),
      poolAddress: config.POOL_ADDRESS,
      chainId: BigInt(config.CHAIN_ID),
    })
    const read = await readSafePositions({
      publicClient,
      poolAddress: config.POOL_ADDRESS,
      chainId: BigInt(config.CHAIN_ID),
      safeAddress: config.SAFE_ADDRESS,
      trackedHedgeIds: new Set<bigint>(),
    })
    const hedgeCount = read.hedgePositions.length
    snap.positions = `${read.positions.length} open (${hedgeCount} hedge loan${hedgeCount === 1 ? '' : 's'})`

    // Price signal (best-effort; falls back to pool tick for the delta calc).
    const s0 = STABLES.has(md.token0Symbol.toUpperCase())
    const s1 = STABLES.has(md.token1Symbol.toUpperCase())
    const ethTokenIndex: 0n | 1n | undefined = s0 && !s1 ? 1n : s1 && !s0 ? 0n : undefined
    let signalTick = pool.currentTick
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
      snap.priceSignal = `unavailable: ${err instanceof Error ? err.message : String(err)}`
    } finally {
      source.stop?.()
    }

    const plan = await computeHedgePlan({
      publicClient,
      poolAddress: config.POOL_ADDRESS,
      chainId: BigInt(config.CHAIN_ID),
      safeAddress: config.SAFE_ADDRESS,
      signalTick,
      assetIndex: config.ASSET_INDEX as 0n | 1n,
      deltaThresholdBps: config.DELTA_THRESHOLD_BPS,
      absoluteMaxHedgeCount: config.MAX_HEDGE_SLOTS,
      slippageBps: BigInt(config.SLIPPAGE_BPS),
      positions: read.positions,
      hedgePositions: read.hedgePositions,
    })
    const dec = config.ASSET_INDEX === 0n ? Number(md.token0Decimals) : Number(md.token1Decimals)
    const sym = config.ASSET_INDEX === 0n ? md.token0Symbol : md.token1Symbol
    snap.netDelta = `${formatUnits(plan.netDelta, dec)} ${sym} (drift ${plan.driftBps}bps, action ${plan.action})`
  } catch (err) {
    notes.push(`on-chain read failed: ${err instanceof Error ? err.message : String(err)}`)
  }

  return snap
}
