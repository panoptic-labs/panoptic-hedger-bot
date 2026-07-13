import type { Account, PublicClient } from 'viem'
import { beforeEach, describe, expect, it, vi } from 'vitest'

import type { HedgerBotConfig } from './config'
import type { HedgeExecutionResult, HedgeExecutor } from './executor/types'
import { computeHedgePlan } from './hedge/decision'
import { readSafePositions } from './hedge/positionReader'
import { HedgerBot } from './hedgerBot'
import type { RolesExecutor } from './safe/rolesExecutor'

vi.mock('@panoptic-eng/sdk/v2', () => ({
  getPool: vi.fn(async () => ({
    healthStatus: 'active',
    poolKey: { tickSpacing: 10 },
    poolId: 1n,
    currentTick: 0n,
    metadata: {
      token0Asset: '0x0000000000000000000000000000000000000001',
      token1Asset: '0x0000000000000000000000000000000000000002',
      collateralToken0Address: '0x0000000000000000000000000000000000000003',
      collateralToken1Address: '0x0000000000000000000000000000000000000004',
      token0Symbol: 'WETH',
      token1Symbol: 'USDC',
      token0Decimals: 18n,
      token1Decimals: 6n,
    },
  })),
  getAccountBuyingPower: vi.fn(async () => ({
    collateralBalance0: 0n,
    requiredCollateral0: 0n,
    collateralBalance1: 0n,
    requiredCollateral1: 0n,
  })),
  isNonceError: () => false,
  isRetryableRpcError: () => false,
  tickToSqrtPriceX96: () => 1n << 96n,
}))
vi.mock('./hedge/positionReader', () => ({ readSafePositions: vi.fn() }))
vi.mock('./hedge/safety', () => ({
  assessSafety: vi.fn(async () => ({ safe: true, reasons: [], isLiquidatable: false })),
}))
vi.mock('./hedge/decision', () => ({ computeHedgePlan: vi.fn() }))

const CONFIG = {
  CHAIN_ID: 1,
  POOL_ADDRESS: '0x00000000000000000000000000000000000000aa',
  SAFE_ADDRESS: '0x00000000000000000000000000000000000000bb',
  ASSET_INDEX: 1n,
  DELTA_THRESHOLD_BPS: 200n,
  MAX_HEDGE_SLOTS: 4,
  SLIPPAGE_BPS: 30,
  DRY_RUN: false,
  URGENT_DRIFT_MULTIPLIER: 3,
  TX_RECEIPT_TIMEOUT_MS: 180_000,
  SIGNAL_TICK_SANITY_MAX: 5_000,
} as unknown as HedgerBotConfig

/** A permissive gas policy stub: never defers, never alerts. */
const openGasPolicy = {
  assess: async () => ({
    proceed: true,
    urgent: false,
    baseFeeGwei: 1,
    capGwei: 50,
    shouldNotifySkip: false,
  }),
  fees: async () => undefined,
  checkKeeperBalance: async () => undefined,
}

/** Two open width=0 hedge loans (7n, 8n) held by the Safe on every read. */
const loanLeg = { width: 0n } as never
const positionsOnChain = [
  { tokenId: 7n, legs: [loanLeg], positionSize: 10n, tickAtMint: 0n },
  { tokenId: 8n, legs: [loanLeg], positionSize: 10n, tickAtMint: 0n },
]

/** A plan that closes hedge 7n. */
const closeSevenPlan = {
  action: 'close_all',
  mints: [],
  burns: [7n],
  swapAtMint: true,
  H: -20n,
  Hstar: 0n,
  driftBps: 0n,
  triggers: { drift: false, overCap: false, signFlip: true },
  netDelta: -20n,
  portfolioSize: 100n,
  intent: {
    action: 'close_all',
    openTokenId: null,
    openPositionSize: null,
    swapAtMint: true,
    closeTokenIds: [7n],
    existingPositionIds: [7n, 8n],
    currentTick: 0n,
    slippageBps: 30n,
  },
} as never

type BotDeps = ConstructorParameters<typeof HedgerBot>[0]

function makeBot(
  executeResult: HedgeExecutionResult,
  receiptStatus: 'success' | 'reverted',
  overrides: Partial<Pick<BotDeps, 'executor' | 'notifier' | 'gasPolicy'>> = {},
) {
  const execute = vi.fn(async () => executeResult)
  const publicClient = {
    waitForTransactionReceipt: vi.fn(async () => ({ status: receiptStatus })),
  } as unknown as PublicClient
  const bot = new HedgerBot({
    config: CONFIG,
    publicClient,
    account: {} as Account,
    priceSource: {
      kind: 'pool-tick',
      getSignal: async () => ({ tick: 0n, observedAtMs: 0, source: 'pool-tick' as const }),
    },
    vaultAsset: { decimals: 6, symbol: 'USDC' },
    executor:
      overrides.executor ?? ({ kind: 'same-pool-loan', execute } as unknown as HedgeExecutor),
    rolesExecutor: {} as RolesExecutor,
    notifier: overrides.notifier ?? { notify: vi.fn(async () => undefined) },
    gasPolicy: overrides.gasPolicy ?? openGasPolicy,
  })
  return { bot, execute, publicClient }
}

/** The tracked-hedge set the bot handed to the position reader on a given call. */
function trackedIdsOnCall(callIndex: number): Set<bigint> {
  const mock = vi.mocked(readSafePositions).mock
  return mock.calls[callIndex][0].trackedHedgeIds
}

beforeEach(() => {
  vi.mocked(readSafePositions).mockReset()
  vi.mocked(readSafePositions).mockResolvedValue({
    positions: positionsOnChain as never,
    hedgePositions: positionsOnChain as never,
  })
  vi.mocked(computeHedgePlan).mockReset()
  vi.mocked(computeHedgePlan).mockResolvedValue(closeSevenPlan)
})

describe('HedgerBot gas deferral gate', () => {
  const deferResult = {
    txHashes: [],
    openedTokenId: null,
    closedTokenIds: [7n],
    dryRun: false,
  } as unknown as HedgeExecutionResult

  it('a deferring gas policy blocks execution before the executor runs', async () => {
    const execute = vi.fn()
    const notify = vi.fn(async () => undefined)
    const { bot } = makeBot(deferResult, 'success', {
      executor: { kind: 'same-pool-loan', execute } as unknown as HedgeExecutor,
      notifier: { notify },
      gasPolicy: {
        ...openGasPolicy,
        assess: vi.fn(async () => ({
          proceed: false,
          urgent: false,
          baseFeeGwei: 120,
          capGwei: 50,
          shouldNotifySkip: true,
        })),
      },
    })
    await bot.runCycle('c1')
    expect(execute).not.toHaveBeenCalled()
    expect(notify).toHaveBeenCalledTimes(1)
  })

  it('passes urgency (drift >= multiplier x threshold) to the gas policy', async () => {
    const assess = vi.fn(async () => ({
      proceed: false,
      urgent: true,
      baseFeeGwei: 120,
      capGwei: 300,
      shouldNotifySkip: false,
    }))
    vi.mocked(computeHedgePlan).mockResolvedValue({
      ...(closeSevenPlan as object),
      driftBps: 700n, // >= 3 x 200
    } as never)
    const { bot } = makeBot(deferResult, 'success', {
      executor: { kind: 'same-pool-loan', execute: vi.fn() } as unknown as HedgeExecutor,
      gasPolicy: { ...openGasPolicy, assess },
    })
    await bot.runCycle('c1')
    expect(assess).toHaveBeenCalledWith(true)
  })
})

describe('HedgerBot hedge tracking vs execution outcome', () => {
  it('dry-run does not mutate the tracked hedge set', async () => {
    const { bot } = makeBot(
      { txHashes: [], openedTokenId: null, closedTokenIds: [7n], dryRun: true },
      'success',
    )
    await bot.runCycle('c1') // seeds tracker {7n, 8n}, then "closes" 7n in dry-run
    await bot.runCycle('c2')
    // 7n is still open on-chain; a dry-run must not declassify it as a hedge.
    expect(trackedIdsOnCall(1)).toEqual(new Set([7n, 8n]))
  })

  it('a reverted dispatch does not mutate the tracked hedge set', async () => {
    const { bot } = makeBot(
      { txHashes: ['0x01'], openedTokenId: null, closedTokenIds: [7n], dryRun: false },
      'reverted',
    )
    await bot.runCycle('c1')
    await bot.runCycle('c2')
    expect(trackedIdsOnCall(1)).toEqual(new Set([7n, 8n]))
  })

  it('a successful dispatch applies burns to the tracked hedge set', async () => {
    const { bot, publicClient } = makeBot(
      { txHashes: ['0x01'], openedTokenId: null, closedTokenIds: [7n], dryRun: false },
      'success',
    )
    await bot.runCycle('c1')
    await bot.runCycle('c2')
    expect(publicClient.waitForTransactionReceipt).toHaveBeenCalledWith({
      hash: '0x01',
      timeout: CONFIG.TX_RECEIPT_TIMEOUT_MS,
    })
    expect(trackedIdsOnCall(1)).toEqual(new Set([8n]))
  })
})
