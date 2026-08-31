import type { Account, PublicClient } from 'viem'
import { beforeEach, describe, expect, it, vi } from 'vitest'

import type { HedgerBotConfig } from './config'
import type { CollateralSwapRequest, HedgeExecutionResult, HedgeExecutor } from './executor/types'
import { computeHedgePlan } from './hedge/decision'
import { assessSafety } from './hedge/safety'
import { readHedgeSnapshot } from './hedge/snapshot'
import { HedgerBot } from './hedgerBot'
import { type RolesExecutor, TxNotMinedError } from './safe/rolesExecutor'

vi.mock('@panoptic-eng/sdk/v2', () => ({
  getChainDeployment: () => undefined,
  getPool: vi.fn(async () => ({
    healthStatus: 'active',
    poolKey: { tickSpacing: 10 },
    tickSpacing: 10n,
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
  // Marker-based so individual tests can flag an error as transient.
  isRetryableRpcError: (error: unknown) =>
    (error as { retryable?: boolean } | null)?.retryable === true,
  isGasError: () => false,
  parsePanopticError: () => null,
  tickToSqrtPriceX96: () => 1n << 96n,
}))
vi.mock('./hedge/snapshot', () => ({ readHedgeSnapshot: vi.fn() }))
vi.mock('./hedge/safety', () => ({
  assessSafety: vi.fn(() => ({ safe: true, reasons: [], isLiquidatable: false })),
}))
vi.mock('./hedge/decision', () => ({ computeHedgePlan: vi.fn() }))
// Real greeks need fully-formed legs; the deleverage-path tests only care about
// per-position |delta| for the pre-sort, so stub it deterministically.
vi.mock('./hedge/frame', () => ({
  computePortfolioDeltaDetailed: vi.fn(() => ({
    positions: [
      { tokenId: 5n, total: -100n },
      { tokenId: 7n, total: 20n },
    ],
    total: -80n,
  })),
}))

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
  MIN_MARGIN_RESERVE_BPS: 2_000n,
  DELTA_OFFSET_BPS: 0n,
  DELEVERAGE_TRIGGER_MARGIN_BPS: 500n,
  DELEVERAGE_TARGET_MARGIN_BPS: 1_500n,
  DELEVERAGE_SLIPPAGE_BPS: 300,
  DELEVERAGE_COOLDOWN_MS: 300_000,
  BALANCE_FIRST_ENABLED: true,
} as unknown as HedgerBotConfig

/** A permissive gas policy stub: never defers, never alerts. */
const openGasPolicy = {
  assess: async () => ({
    proceed: true,
    urgent: false,
    baseFeeGwei: '1',
    capGwei: '50',
    shouldNotifySkip: false,
  }),
  fees: async () => undefined,
  bumped: async () => null,
  checkKeeperBalance: async () => undefined,
}

/** Two open width=0 hedge loans (7n, 8n) held by the Safe on every read. */
const loanLeg = { width: 0n } as never
const positionsOnChain = [
  { tokenId: 7n, legs: [loanLeg], positionSize: 10n, tickAtMint: 0n },
  { tokenId: 8n, legs: [loanLeg], positionSize: 10n, tickAtMint: 0n },
]

const defaultBuyingPower = {
  collateralBalance0: 0n,
  requiredCollateral0: 0n,
  collateralBalance1: 0n,
  requiredCollateral1: 0n,
}

const snapshot = (
  positions = positionsOnChain,
  hedgePositions = positionsOnChain,
  buyingPower = defaultBuyingPower,
) =>
  ({
    blockNumber: 123n,
    positions,
    hedgePositions,
    pool: {
      poolId: 1n,
      healthStatus: 'active',
      currentTick: 0n,
      tickSpacing: 10n,
      poolKey: { tickSpacing: 10 },
      metadata: {
        token0Decimals: 18n,
        token1Decimals: 6n,
        token0Symbol: 'WETH',
        token1Symbol: 'USDC',
      },
    },
    safeMode: { level: 0n, mode: 'normal' },
    buyingPower,
    collateral: { token0: { assets: 0n }, token1: { assets: 0n } },
    liquidation: {
      isLiquidatable: false,
      currentMargin0: 10_000n,
      requiredMargin0: 5_000n,
      currentMargin1: 10_000n,
      requiredMargin1: 5_000n,
      denominatedInToken: 1n,
    },
  }) as never

/** A plan that closes hedge 7n. */
const closeSevenPlan = {
  action: 'close_all',
  mints: [],
  burns: [7n],
  swapAtMint: true,
  H: -20n,
  Hstar: 0n,
  driftBps: 0n,
  triggers: { drift: true, timedDrift: false, overCap: false },
  netDelta: -20n,
  portfolioSize: 100n,
  intent: {
    action: 'close_all',
    openTokenId: null,
    openPositionSize: null,
    swapAtMint: true,
    closeTokenIds: [7n],
    existingPositionIds: [7n, 8n],
    skippedCollidingTokenIds: [],
    currentTick: 0n,
    slippageBps: 30n,
  },
} as unknown as ReturnType<typeof computeHedgePlan>

/** A consolidation that burns both old loans before minting one replacement. */
const consolidatePlan = {
  action: 'consolidate',
  mints: [{ tokenType: 1n, size: 20n }],
  burns: [7n, 8n],
  swapAtMint: false,
  H: -20n,
  Hstar: -20n,
  driftBps: 0n,
  triggers: { drift: false, timedDrift: false, overCap: true },
  netDelta: 0n,
  portfolioSize: 100n,
  intent: {
    action: 'consolidate',
    openTokenId: 99n,
    openPositionSize: 20n,
    swapAtMint: false,
    closeTokenIds: [7n, 8n],
    existingPositionIds: [7n, 8n],
    skippedCollidingTokenIds: [],
    currentTick: 0n,
    slippageBps: 30n,
  },
} as unknown as ReturnType<typeof computeHedgePlan>

const openBalanceFirstPlan = {
  action: 'open',
  mints: [{ tokenType: 0n, size: 100n }],
  burns: [],
  swapAtMint: true,
  H: 0n,
  Hstar: 100n,
  driftBps: 1_000n,
  triggers: { drift: true, timedDrift: false, overCap: false },
  netDelta: -100n,
  portfolioSize: 1_000n,
  intent: {
    action: 'open',
    openTokenId: 99n,
    openPositionSize: 100n,
    swapAtMint: true,
    closeTokenIds: [],
    existingPositionIds: [7n, 8n],
    skippedCollidingTokenIds: [],
    currentTick: 0n,
    slippageBps: 30n,
  },
} as unknown as ReturnType<typeof computeHedgePlan>

type BotDeps = ConstructorParameters<typeof HedgerBot>[0]

async function makeBot(
  executeResult: HedgeExecutionResult,
  receiptStatus: 'success' | 'reverted',
  overrides: Partial<
    Pick<
      BotDeps,
      | 'executor'
      | 'deleveragerExecutor'
      | 'sfpmVenue'
      | 'pendingSwapStore'
      | 'notifier'
      | 'gasPolicy'
      | 'hedgeJournal'
      | 'recordDeltaHedge'
    >
  > = {},
) {
  const receipt = {
    status: receiptStatus,
    transactionHash: '0x01',
    blockNumber: 123n,
    blockHash: `0x${'ab'.repeat(32)}`,
  } as never
  const normalizedResult = executeResult.dryRun
    ? executeResult
    : { ...executeResult, transactionHash: '0x01', receipt }
  const execute = vi.fn(async (..._args: unknown[]) => normalizedResult)
  const publicClient = {
    getBlockNumber: vi.fn(async () => 123n),
    waitForTransactionReceipt: vi.fn(async () => ({
      status: receiptStatus,
      transactionHash: '0x01',
      blockNumber: 123n,
      blockHash: `0x${'ab'.repeat(32)}`,
    })),
  } as unknown as PublicClient
  const notifier = overrides.notifier ?? { notify: vi.fn(async () => undefined) }
  let pendingSwap: ReturnType<NonNullable<BotDeps['pendingSwapStore']>['read']> = null
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
    deleveragerExecutor: overrides.deleveragerExecutor,
    sfpmVenue: overrides.sfpmVenue,
    pendingSwapStore: overrides.pendingSwapStore ?? {
      read: () => pendingSwap,
      save: (value) => {
        pendingSwap = value
      },
      clear: () => {
        pendingSwap = null
      },
    },
    rolesExecutor: { preflight: vi.fn(async () => undefined) } as unknown as RolesExecutor,
    notifier,
    gasPolicy: overrides.gasPolicy ?? openGasPolicy,
    // Unused here: readHedgeSnapshot (the only storage consumer) is mocked.
    storage: {} as never,
    hedgeJournal: overrides.hedgeJournal ?? {
      begin: vi.fn(() => '00000000-0000-4000-8000-000000000001'),
      observeTransaction: vi.fn(),
      recordBroadcastAttempt: vi.fn(),
      confirm: vi.fn(),
      fail: vi.fn(),
      recover: vi.fn(async () => ({ held: [] })),
      hasPendingIntent: () => false,
      checkpoint: () => ({}),
    },
    recordDeltaHedge: overrides.recordDeltaHedge,
  })
  await bot.init()
  vi.mocked(notifier.notify).mockClear()
  return { bot, execute, publicClient }
}

beforeEach(() => {
  vi.mocked(readHedgeSnapshot).mockReset()
  vi.mocked(readHedgeSnapshot).mockResolvedValue(snapshot())
  vi.mocked(computeHedgePlan).mockReset()
  vi.mocked(computeHedgePlan).mockReturnValue(closeSevenPlan)
  vi.mocked(assessSafety).mockReset()
  vi.mocked(assessSafety).mockReturnValue({
    safe: true,
    verdict: 'hedge',
    reasons: [],
    isLiquidatable: false,
    paused: false,
  })
})

describe('HedgerBot gas deferral gate', () => {
  const deferResult = {
    transactionHash: null,
    receipt: null,
    openedTokenId: null,
    closedTokenIds: [7n],
    dryRun: false,
  } as unknown as HedgeExecutionResult

  it('a deferring gas policy blocks execution before the executor runs', async () => {
    const execute = vi.fn()
    const notify = vi.fn(async (_message: unknown) => undefined)
    const { bot } = await makeBot(deferResult, 'success', {
      executor: { kind: 'same-pool-loan', execute } as unknown as HedgeExecutor,
      notifier: { notify },
      gasPolicy: {
        ...openGasPolicy,
        assess: vi.fn(async () => ({
          proceed: false,
          urgent: false,
          baseFeeGwei: '120',
          capGwei: '50',
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
      baseFeeGwei: '120',
      capGwei: '300',
      shouldNotifySkip: false,
    }))
    vi.mocked(computeHedgePlan).mockReturnValue({
      ...(closeSevenPlan as object),
      driftBps: 700n, // >= 3 x 200
    } as never)
    const { bot } = await makeBot(deferResult, 'success', {
      executor: { kind: 'same-pool-loan', execute: vi.fn() } as unknown as HedgeExecutor,
      gasPolicy: { ...openGasPolicy, assess },
    })
    await bot.runCycle('c1')
    expect(assess).toHaveBeenCalledWith(true)
  })

  it('threads urgency into the executor context', async () => {
    vi.mocked(computeHedgePlan).mockReturnValue({
      ...(closeSevenPlan as object),
      driftBps: 700n, // >= 3 x 200
    } as never)
    const { bot, execute } = await makeBot(deferResult, 'success')
    await bot.runCycle('c1')
    expect(execute.mock.calls[0][1]).toMatchObject({ urgent: true })
  })

  it('marks routine drift non-urgent in the executor context', async () => {
    const { bot, execute } = await makeBot(deferResult, 'success') // driftBps=0
    await bot.runCycle('c1')
    expect(execute.mock.calls[0][1]).toMatchObject({ urgent: false })
  })

  it('keeps a timed-drift hedge on the routine gas policy', async () => {
    const assess = vi.fn(openGasPolicy.assess)
    vi.mocked(computeHedgePlan).mockReturnValue({
      ...(closeSevenPlan as object),
      driftBps: 150n,
      triggers: { drift: false, timedDrift: true, overCap: false },
    } as never)
    const { bot } = await makeBot(deferResult, 'success', {
      gasPolicy: { ...openGasPolicy, assess },
    })
    await bot.runCycle('timed')
    expect(assess).toHaveBeenCalledWith(false)
  })
})

describe('HedgerBot timed cadence checkpoint', () => {
  const live = {
    transactionHash: '0x01',
    receipt: null,
    openedTokenId: null,
    closedTokenIds: [7n],
    dryRun: false,
  } as unknown as HedgeExecutionResult

  it('advances only after a confirmed delta-changing live action', async () => {
    const recordDeltaHedge = vi.fn()
    const { bot } = await makeBot(live, 'success', { recordDeltaHedge })
    await bot.runCycle('c1')
    expect(recordDeltaHedge).toHaveBeenCalledTimes(1)
  })

  it('does not advance for a dry run or state-preserving consolidation', async () => {
    const recordDeltaHedge = vi.fn()
    const dry = { ...live, dryRun: true }
    const dryBot = await makeBot(dry, 'success', { recordDeltaHedge })
    await dryBot.bot.runCycle('dry')
    expect(recordDeltaHedge).not.toHaveBeenCalled()

    vi.mocked(computeHedgePlan).mockReturnValue(consolidatePlan)
    const consolidateBot = await makeBot(live, 'success', {
      recordDeltaHedge,
      executor: {
        kind: 'same-pool-loan',
        previewFinalState: vi.fn(async () => ({ success: true, margin: defaultBuyingPower })),
        execute: vi.fn(async () => live),
      } as unknown as HedgeExecutor,
    })
    await consolidateBot.bot.runCycle('consolidate')
    expect(recordDeltaHedge).not.toHaveBeenCalled()
  })
})

describe('HedgerBot final-state margin reserve', () => {
  const executionResult = {
    transactionHash: '0x01',
    receipt: {
      status: 'success',
      transactionHash: '0x01',
      blockNumber: 123n,
      blockHash: `0x${'ab'.repeat(32)}`,
    },
    openedTokenId: 99n,
    closedTokenIds: [7n, 8n],
    dryRun: false,
  } as unknown as HedgeExecutionResult

  beforeEach(() => {
    vi.mocked(readHedgeSnapshot).mockResolvedValue(
      snapshot(positionsOnChain, positionsOnChain, {
        collateralBalance0: 1_000n,
        requiredCollateral0: 850n,
        collateralBalance1: 1_000n,
        requiredCollateral1: 850n,
      }),
    )
    vi.mocked(computeHedgePlan).mockReturnValue(consolidatePlan)
  })

  it('allows consolidation when 15% free before becomes 50% free afterward', async () => {
    const previewFinalState = vi.fn(async () => ({
      success: true as const,
      margin: {
        collateralBalance0: 1_000n,
        requiredCollateral0: 500n,
        collateralBalance1: 1_000n,
        requiredCollateral1: 500n,
      },
    }))
    const execute = vi.fn(async () => executionResult)
    const { bot } = await makeBot(executionResult, 'success', {
      executor: { kind: 'same-pool-loan', previewFinalState, execute },
    })

    expect(await bot.runCycle('c1')).toBe('complete')
    expect(previewFinalState).toHaveBeenCalledTimes(2)
    expect(previewFinalState).toHaveBeenNthCalledWith(1, consolidatePlan.intent, 123n)
    expect(execute).toHaveBeenCalledTimes(1)
  })

  it('rejects consolidation when the simulated final state remains below reserve', async () => {
    const previewFinalState = vi.fn(async () => ({
      success: true as const,
      margin: {
        collateralBalance0: 1_000n,
        requiredCollateral0: 850n,
        collateralBalance1: 1_000n,
        requiredCollateral1: 850n,
      },
    }))
    const execute = vi.fn(async () => executionResult)
    const { bot } = await makeBot(executionResult, 'success', {
      executor: { kind: 'same-pool-loan', previewFinalState, execute },
    })

    expect(await bot.runCycle('c1')).toBe('complete')
    expect(previewFinalState).toHaveBeenCalledTimes(1)
    expect(execute).not.toHaveBeenCalled()
  })
})

describe('HedgerBot balance-first collateral swaps', () => {
  const receipt = {
    status: 'success',
    transactionHash: '0x03',
    blockNumber: 124n,
    blockHash: `0x${'cd'.repeat(32)}`,
  } as never

  beforeEach(() => {
    vi.mocked(computeHedgePlan).mockReturnValue(openBalanceFirstPlan)
  })

  it('leaves 50bps in the CollateralTracker when swapping numeraire in-pool', async () => {
    vi.mocked(readHedgeSnapshot).mockResolvedValue({
      ...snapshot(),
      pool: {
        ...snapshot().pool,
        poolId: 1n,
        tickSpacing: 10n,
        poolKey: { tickSpacing: 10 },
      },
      collateral: { token0: { assets: 0n }, token1: { assets: 200n } },
      walletBalances: {
        token0: { token: 0n, native: 0n, total: 0n },
        token1: { token: 0n, native: 0n, total: 0n },
      },
    } as never)
    const execute = vi.fn()
    const deriveSwapRequirement = vi.fn(async () => ({
      sellTokenType: 1 as const,
      amountIn: 199n,
      inPoolAmountOut: 100n,
    }))
    const simulateCollateralSwap = vi.fn(async () => undefined)
    const executeCollateralSwap = vi.fn(async () => ({
      transactionHash: receipt.transactionHash,
      receipt,
      amountIn: 200n,
      dryRun: false,
    }))
    const previewFinalState = vi.fn(async () => ({
      success: true as const,
      margin: {
        collateralBalance0: 10_000n,
        requiredCollateral0: 0n,
        collateralBalance1: 10_000n,
        requiredCollateral1: 0n,
      },
    }))
    const { bot } = await makeBot({} as HedgeExecutionResult, 'success', {
      executor: {
        kind: 'same-pool-loan',
        execute,
        previewFinalState,
        deriveSwapRequirement,
        simulateCollateralSwap,
        executeCollateralSwap,
      } as unknown as HedgeExecutor,
    })

    expect(await bot.runCycle('c1')).toBe('complete')
    expect(simulateCollateralSwap).toHaveBeenCalledWith(
      expect.objectContaining({ kind: 'exactIn', tokenType: 1, amountIn: 199n }),
    )
    expect(executeCollateralSwap).toHaveBeenCalledTimes(1)
    expect(execute).not.toHaveBeenCalled()
  })

  it('leaves 50bps of loose Safe numeraire after a standalone off-venue swap', async () => {
    vi.mocked(readHedgeSnapshot).mockResolvedValue({
      ...snapshot(),
      pool: {
        ...snapshot().pool,
        poolId: 1n,
        tickSpacing: 10n,
        poolKey: { tickSpacing: 10 },
      },
      collateral: { token0: { assets: 0n }, token1: { assets: 0n } },
      walletBalances: {
        token0: { token: 0n, native: 0n, total: 0n },
        token1: { token: 200n, native: 0n, total: 200n },
      },
    } as never)
    const execute = vi.fn()
    const sfpmSimulate = vi.fn(async () => undefined)
    const sfpmExecute = vi.fn(async () => ({
      transactionHash: receipt.transactionHash,
      receipt,
      amountIn: 199n,
      amountOut: 100n,
      dryRun: false,
    }))
    const { bot } = await makeBot({} as HedgeExecutionResult, 'success', {
      executor: {
        kind: 'same-pool-loan',
        execute,
        previewFinalState: vi.fn(async () => ({
          success: true as const,
          margin: { token0: { free: 10_000n }, token1: { free: 10_000n } },
        })),
        deriveSwapRequirement: vi.fn(async () => ({
          sellTokenType: 1 as const,
          amountIn: 200n,
          inPoolAmountOut: 95n,
        })),
        simulateCollateralSwap: vi.fn(),
        executeCollateralSwap: vi.fn(),
      } as unknown as HedgeExecutor,
      sfpmVenue: {
        coordinator: {
          evaluate: vi.fn(async () => ({
            use: true,
            sellToken0: false,
            swapAmount: 200n,
            amountOut: 100n,
            swapPoolTick: 0,
          })),
          quoteSwap: vi.fn(async () => ({ amountOut: 99n, swapPoolTick: 0 })),
        },
        sfpmExecutor: {
          simulate: sfpmSimulate,
          execute: sfpmExecute,
          readWalletBalances: vi.fn(),
          redepositWalletBalances: vi.fn(),
        },
      } as never,
    })

    expect(await bot.runCycle('c1')).toBe('complete')
    expect(sfpmSimulate).toHaveBeenCalledWith(
      expect.objectContaining({ amount: 199n, positionIdList: [7n, 8n] }),
    )
    expect(sfpmExecute).toHaveBeenCalledTimes(1)
    expect(execute).not.toHaveBeenCalled()
  })

  it('falls back to the loan hedge when the balance-first preflight rejects the withdrawal', async () => {
    vi.mocked(readHedgeSnapshot).mockResolvedValue({
      ...snapshot(),
      pool: {
        ...snapshot().pool,
        poolId: 1n,
        tickSpacing: 10n,
        poolKey: { tickSpacing: 10 },
      },
      collateral: { token0: { assets: 0n }, token1: { assets: 200n } },
      walletBalances: {
        token0: { token: 0n, native: 0n, total: 0n },
        token1: { token: 0n, native: 0n, total: 0n },
      },
    } as never)
    const loanResult = {
      transactionHash: '0x04',
      receipt: {
        status: 'success',
        transactionHash: '0x04',
        blockNumber: 125n,
        blockHash: `0x${'ef'.repeat(32)}`,
      },
      openedTokenId: 99n,
      closedTokenIds: [],
      dryRun: false,
    } as unknown as HedgeExecutionResult
    const execute = vi.fn(async () => loanResult)
    const sfpmExecute = vi.fn()
    const executeCollateralSwap = vi.fn()
    const { bot } = await makeBot(loanResult, 'success', {
      executor: {
        kind: 'same-pool-loan',
        execute,
        deriveSwapRequirement: vi.fn(async () => ({
          sellTokenType: 1 as const,
          amountIn: 199n,
          inPoolAmountOut: 100n,
        })),
        // High pool utilization: CT.withdraw preflight rejects the standalone swap.
        simulateCollateralSwap: vi.fn(async () => {
          throw new Error('input CollateralTracker withdrawal rejected: ExceedsMaximumRedemption')
        }),
        executeCollateralSwap,
        previewFinalState: vi.fn(async () => ({
          success: true as const,
          margin: {
            collateralBalance0: 1_000n,
            requiredCollateral0: 100n,
            collateralBalance1: 1_000n,
            requiredCollateral1: 100n,
          },
        })),
      } as unknown as HedgeExecutor,
    })

    expect(await bot.runCycle('c1')).toBe('complete')
    expect(execute).toHaveBeenCalledTimes(1)
    expect(executeCollateralSwap).not.toHaveBeenCalled()
    expect(sfpmExecute).not.toHaveBeenCalled()
  })
})

describe('HedgerBot SafeMode=1 credit-swap fallback', () => {
  const receipt = {
    status: 'success',
    transactionHash: '0x05',
    blockNumber: 126n,
    blockHash: `0x${'12'.repeat(32)}`,
  } as never

  beforeEach(() => {
    vi.mocked(computeHedgePlan).mockReturnValue(openBalanceFirstPlan)
    vi.mocked(readHedgeSnapshot).mockResolvedValue({
      ...snapshot(),
      safeMode: { level: 1n, mode: 'restricted' },
      pool: { ...snapshot().pool, healthStatus: 'low_liquidity' },
      collateral: { token0: { assets: 1_000n }, token1: { assets: 0n } },
    } as never)
  })

  it('buys the full hedge asset exact-out after the persistent loan simulation fails', async () => {
    const execute = vi.fn()
    const simulateCollateralSwap = vi.fn(async () => ({ amountIn: 500n, amountOut: 100n }))
    const executeCollateralSwap = vi.fn(async () => ({
      transactionHash: receipt.transactionHash,
      receipt,
      amountIn: 500n,
      dryRun: false,
    }))
    const { bot } = await makeBot({} as HedgeExecutionResult, 'success', {
      executor: {
        kind: 'same-pool-loan',
        execute,
        previewFinalState: vi.fn(async () => ({ success: false as const, reason: 'SafeMode' })),
        simulateCollateralSwap,
        executeCollateralSwap,
      } as unknown as HedgeExecutor,
    })

    expect(await bot.runCycle('safe-mode')).toBe('complete')
    expect(simulateCollateralSwap).toHaveBeenCalledWith(
      expect.objectContaining({ kind: 'exactOut', tokenType: 1, amountOut: 100n }),
    )
    expect(executeCollateralSwap).toHaveBeenCalledTimes(1)
    expect(execute).not.toHaveBeenCalled()
  })

  it('uses a collateral-limited exact-in partial hedge when full exact-out is unaffordable', async () => {
    const simulateCollateralSwap = vi.fn(async (request: CollateralSwapRequest) =>
      request.kind === 'exactOut'
        ? { amountIn: 2_000n, amountOut: request.amountOut }
        : { amountIn: request.amountIn, amountOut: 50n },
    )
    const executeCollateralSwap = vi.fn(async () => ({
      transactionHash: receipt.transactionHash,
      receipt,
      amountIn: 995n,
      dryRun: false,
    }))
    const { bot } = await makeBot({} as HedgeExecutionResult, 'success', {
      executor: {
        kind: 'same-pool-loan',
        execute: vi.fn(),
        previewFinalState: vi.fn(async () => ({ success: false as const, reason: 'SafeMode' })),
        simulateCollateralSwap,
        executeCollateralSwap,
      } as unknown as HedgeExecutor,
    })

    expect(await bot.runCycle('safe-mode')).toBe('complete')
    expect(executeCollateralSwap).toHaveBeenCalledWith(
      expect.objectContaining({ kind: 'exactIn', tokenType: 0, amountIn: 995n }),
      expect.any(Object),
    )
  })

  it('does not spend the full balance when the exact-out simulation fails', async () => {
    const simulateCollateralSwap = vi.fn(async () => {
      throw new Error('quote unavailable')
    })
    const executeCollateralSwap = vi.fn()
    const execute = vi.fn()
    const { bot } = await makeBot({} as HedgeExecutionResult, 'success', {
      executor: {
        kind: 'same-pool-loan',
        execute,
        previewFinalState: vi.fn(async () => ({ success: false as const, reason: 'SafeMode' })),
        simulateCollateralSwap,
        executeCollateralSwap,
      } as unknown as HedgeExecutor,
    })

    expect(await bot.runCycle('safe-mode')).toBe('complete')
    expect(simulateCollateralSwap).toHaveBeenCalledTimes(1)
    expect(simulateCollateralSwap).toHaveBeenCalledWith(
      expect.objectContaining({ kind: 'exactOut' }),
    )
    expect(executeCollateralSwap).not.toHaveBeenCalled()
    expect(execute).not.toHaveBeenCalled()
  })

  it('sells the hedge asset exact-in when the correction is negative', async () => {
    vi.mocked(computeHedgePlan).mockReturnValue({
      ...openBalanceFirstPlan,
      H: 100n,
      Hstar: 0n,
    } as never)
    vi.mocked(readHedgeSnapshot).mockResolvedValue({
      ...snapshot(),
      safeMode: { level: 1n, mode: 'restricted' },
      pool: { ...snapshot().pool, healthStatus: 'low_liquidity' },
      collateral: { token0: { assets: 0n }, token1: { assets: 1_000n } },
    } as never)
    const simulateCollateralSwap = vi.fn(async (request: CollateralSwapRequest) => ({
      amountIn: request.kind === 'exactIn' ? request.amountIn : 0n,
      amountOut: 80n,
    }))
    const executeCollateralSwap = vi.fn(async () => ({
      transactionHash: receipt.transactionHash,
      receipt,
      amountIn: 100n,
      dryRun: false,
    }))
    const { bot } = await makeBot({} as HedgeExecutionResult, 'success', {
      executor: {
        kind: 'same-pool-loan',
        execute: vi.fn(),
        previewFinalState: vi.fn(async () => ({ success: false as const, reason: 'SafeMode' })),
        simulateCollateralSwap,
        executeCollateralSwap,
      } as unknown as HedgeExecutor,
    })

    expect(await bot.runCycle('safe-mode')).toBe('complete')
    expect(executeCollateralSwap).toHaveBeenCalledWith(
      expect.objectContaining({ kind: 'exactIn', tokenType: 1, amountIn: 100n }),
      expect.any(Object),
    )
  })
})

describe('HedgerBot stuck dispatch (TxNotMinedError)', () => {
  it('alerts once and leaves the tracked hedge set untouched', async () => {
    const notify = vi.fn(async (_message: unknown) => undefined)
    const execute = vi
      .fn()
      .mockRejectedValueOnce(new TxNotMinedError(['0xaa', '0xbb'] as never, 180_000))
      .mockResolvedValue({
        transactionHash: '0x01',
        receipt: {
          status: 'success',
          transactionHash: '0x01',
          blockNumber: 123n,
          blockHash: `0x${'ab'.repeat(32)}`,
        },
        openedTokenId: null,
        closedTokenIds: [],
        dryRun: false,
      })
    const { bot } = await makeBot(
      {
        transactionHash: null,
        receipt: null,
        openedTokenId: null,
        closedTokenIds: [],
        dryRun: false,
      },
      'success',
      {
        executor: { kind: 'same-pool-loan', execute } as unknown as HedgeExecutor,
        notifier: { notify },
      },
    )
    await bot.runCycle('c1') // executor throws TxNotMinedError
    expect(notify).toHaveBeenCalledTimes(1)
    await bot.runCycle('c2')
    // The next cycle re-reads a fresh snapshot and retries; position discovery is
    // now via syncPositions (event scan), so recovery no longer threads a
    // best-guess dispatch hash into the read.
    expect(vi.mocked(readHedgeSnapshot).mock.calls.length).toBe(2)
    expect(execute).toHaveBeenCalledTimes(2)
  })
})

describe('HedgerBot off-venue transaction journal', () => {
  it('confirms tx1 and opens a separate journal intent before tx2 is sent', async () => {
    const order: string[] = []
    const dispatchReceipt = {
      status: 'success',
      transactionHash: '0x01',
      blockNumber: 123n,
      blockHash: `0x${'ab'.repeat(32)}`,
    } as never
    const swapReceipt = {
      status: 'success',
      transactionHash: '0x02',
      blockNumber: 124n,
      blockHash: `0x${'cd'.repeat(32)}`,
    } as never
    const dispatchResult = {
      transactionHash: '0x01',
      receipt: dispatchReceipt,
      openedTokenId: null,
      closedTokenIds: [7n],
      dryRun: false,
    } as HedgeExecutionResult
    const journal = {
      begin: vi.fn((action) => {
        order.push(`begin:${action}`)
        return action === 'sfpm_swap'
          ? '00000000-0000-4000-8000-000000000002'
          : '00000000-0000-4000-8000-000000000001'
      }),
      observeTransaction: vi.fn(),
      recordBroadcastAttempt: vi.fn(),
      confirm: vi.fn((receipt) => order.push(`confirm:${receipt.transactionHash}`)),
      fail: vi.fn(),
      recover: vi.fn(async () => ({ held: [] })),
      hasPendingIntent: () => false,
      checkpoint: () => ({}),
    } satisfies BotDeps['hedgeJournal']
    const executeOffVenue = vi.fn(async () => {
      order.push('send:dispatch')
      return dispatchResult
    })
    const sfpmExecute = vi.fn(async () => {
      order.push('send:swap')
      return {
        transactionHash: '0x02',
        receipt: swapReceipt,
        amountIn: 500n,
        amountOut: 490n,
        dryRun: false,
      } as const
    })
    const { bot } = await makeBot(dispatchResult, 'success', {
      executor: {
        kind: 'same-pool-loan',
        execute: vi.fn(),
        executeOffVenue,
        previewFinalState: vi.fn(),
      },
      sfpmVenue: {
        coordinator: {
          evaluate: vi.fn(async () => ({
            use: true,
            sellToken0: false,
            swapAmount: 500n,
            amountOut: 490n,
            swapPoolTick: 0,
          })),
          quoteSwap: vi.fn(),
        },
        sfpmExecutor: {
          simulate: vi.fn(async () => undefined),
          execute: sfpmExecute,
          readWalletBalances: vi.fn(async () => ({
            token0: { token: 0n, native: 0n, total: 0n },
            token1: { token: 0n, native: 0n, total: 0n },
          })),
          redepositWalletBalances: vi.fn(),
        },
      },
      hedgeJournal: journal,
    })

    await bot.runCycle('c1')

    expect(order).toEqual([
      'begin:close_all',
      'send:dispatch',
      'confirm:0x01',
      'begin:sfpm_swap',
      'send:swap',
      'confirm:0x02',
    ])
    expect(journal.fail).not.toHaveBeenCalled()
  })

  it('clears the durable swap obligation after tx1+tx2 confirm so the next cycle does not re-swap', async () => {
    const dispatchReceipt = {
      status: 'success',
      transactionHash: '0x01',
      blockNumber: 123n,
      blockHash: `0x${'ab'.repeat(32)}`,
    } as never
    const swapReceipt = {
      status: 'success',
      transactionHash: '0x02',
      blockNumber: 124n,
      blockHash: `0x${'cd'.repeat(32)}`,
    } as never
    const dispatchResult = {
      transactionHash: '0x01',
      receipt: dispatchReceipt,
      openedTokenId: null,
      closedTokenIds: [7n],
      dryRun: false,
    } as HedgeExecutionResult
    let pending: Parameters<NonNullable<BotDeps['pendingSwapStore']>['save']>[0] | null = null
    const store = {
      read: vi.fn(() => pending),
      save: vi.fn((value: never) => {
        pending = value
      }),
      clear: vi.fn(() => {
        pending = null
      }),
    }
    const quoteSwap = vi.fn(async () => ({ amountOut: 490n, swapPoolTick: 0 }))
    const sfpmExecute = vi.fn(async () => ({
      transactionHash: '0x02',
      receipt: swapReceipt,
      amountIn: 500n,
      amountOut: 490n,
      dryRun: false,
    }))
    const { bot } = await makeBot(dispatchResult, 'success', {
      executor: {
        kind: 'same-pool-loan',
        execute: vi.fn(),
        executeOffVenue: vi.fn(async () => dispatchResult),
        previewFinalState: vi.fn(),
      },
      pendingSwapStore: store as never,
      sfpmVenue: {
        coordinator: {
          evaluate: vi.fn(async () => ({
            use: true,
            sellToken0: false,
            swapAmount: 500n,
            amountOut: 490n,
            swapPoolTick: 0,
          })),
          quoteSwap,
        },
        sfpmExecutor: {
          simulate: vi.fn(async () => undefined),
          execute: sfpmExecute,
          readWalletBalances: vi.fn(async () => ({
            token0: { token: 0n, native: 0n, total: 0n },
            token1: { token: 0n, native: 0n, total: 0n },
          })),
          redepositWalletBalances: vi.fn(),
        },
      },
    })

    await bot.runCycle('c1')
    expect(sfpmExecute).toHaveBeenCalledTimes(1)
    expect(store.clear).toHaveBeenCalled()
    expect(pending).toBeNull()

    // The next cycle must plan a fresh hedge, not replay the fulfilled
    // obligation through recovery (which would re-quote via quoteSwap).
    await bot.runCycle('c2')
    expect(quoteSwap).not.toHaveBeenCalled()
    expect(sfpmExecute).toHaveBeenCalledTimes(2)
  })

  it('preserves the swap intent when tx2 times out so startup can recover it', async () => {
    const dispatchReceipt = {
      status: 'success',
      transactionHash: '0x01',
      blockNumber: 123n,
      blockHash: `0x${'ab'.repeat(32)}`,
    } as never
    const dispatchResult = {
      transactionHash: '0x01',
      receipt: dispatchReceipt,
      openedTokenId: null,
      closedTokenIds: [7n],
      dryRun: false,
    } as HedgeExecutionResult
    const journal = {
      begin: vi
        .fn()
        .mockReturnValueOnce('00000000-0000-4000-8000-000000000001')
        .mockReturnValueOnce('00000000-0000-4000-8000-000000000002'),
      observeTransaction: vi.fn(),
      recordBroadcastAttempt: vi.fn(),
      confirm: vi.fn(),
      fail: vi.fn(),
      recover: vi.fn(async () => ({ held: [] })),
      hasPendingIntent: () => false,
      checkpoint: () => ({}),
    } satisfies BotDeps['hedgeJournal']
    const { bot } = await makeBot(dispatchResult, 'success', {
      executor: {
        kind: 'same-pool-loan',
        execute: vi.fn(),
        executeOffVenue: vi.fn(async () => dispatchResult),
        previewFinalState: vi.fn(),
      },
      sfpmVenue: {
        coordinator: {
          evaluate: vi.fn(async () => ({
            use: true,
            sellToken0: false,
            swapAmount: 500n,
            amountOut: 490n,
            swapPoolTick: 0,
          })),
          quoteSwap: vi.fn(),
        },
        sfpmExecutor: {
          simulate: vi.fn(async () => undefined),
          execute: vi.fn(async () => {
            throw new TxNotMinedError(['0x02'] as never, 180_000)
          }),
          readWalletBalances: vi.fn(async () => ({
            token0: { token: 0n, native: 0n, total: 0n },
            token1: { token: 0n, native: 0n, total: 0n },
          })),
          redepositWalletBalances: vi.fn(),
        },
      },
      hedgeJournal: journal,
    })

    await bot.runCycle('c1')

    expect(journal.begin).toHaveBeenNthCalledWith(1, 'close_all')
    expect(journal.begin).toHaveBeenNthCalledWith(2, 'sfpm_swap')
    expect(journal.confirm).toHaveBeenCalledOnce()
    expect(journal.confirm).toHaveBeenCalledWith(
      expect.objectContaining({ transactionHash: '0x01' }),
    )
    expect(journal.fail).not.toHaveBeenCalled()
  })

  it('does not repeat a confirmed durable swap when clearing its obligation initially fails', async () => {
    const recordDeltaHedge = vi.fn()
    const dispatchIntentId = '00000000-0000-4000-8000-000000000001'
    const swapIntentId = '00000000-0000-4000-8000-000000000002'
    let pending: {
      dispatchIntentId: string
      swapIntentId?: string
      sellToken0: boolean
      amount: bigint
    } | null = {
      dispatchIntentId,
      sellToken0: true,
      amount: 500n,
    }
    let checkpoint: ReturnType<BotDeps['hedgeJournal']['checkpoint']> = {
      intentId: dispatchIntentId,
      action: 'close_all',
      transactionHash: '0x01' as const,
    }
    const store = {
      read: vi.fn(() => pending),
      save: vi.fn((value) => {
        pending = value
      }),
      clear: vi
        .fn()
        .mockImplementationOnce(() => {
          throw new Error('failed to clear pending swap')
        })
        .mockImplementation(() => {
          pending = null
        }),
    }
    const journal = {
      begin: vi.fn(() => swapIntentId),
      observeTransaction: vi.fn(),
      recordBroadcastAttempt: vi.fn(),
      confirm: vi.fn(() => {
        checkpoint = {
          intentId: swapIntentId,
          action: 'sfpm_swap',
          transactionHash: '0x02',
        }
      }),
      fail: vi.fn(),
      recover: vi.fn(async () => ({ held: [] })),
      hasPendingIntent: () => false,
      checkpoint: () => checkpoint,
    } satisfies BotDeps['hedgeJournal']
    const recoveredReceipt = {
      status: 'success',
      transactionHash: '0x02',
      blockNumber: 124n,
      blockHash: `0x${'cd'.repeat(32)}`,
    } as never
    const sfpmExecute = vi.fn(async () => ({
      transactionHash: '0x02' as const,
      receipt: recoveredReceipt,
      amountIn: 500n,
      amountOut: 490n,
      dryRun: false,
    }))
    const dispatchResult = {
      transactionHash: '0x01',
      receipt: recoveredReceipt,
      openedTokenId: null,
      closedTokenIds: [],
      dryRun: false,
    } as HedgeExecutionResult
    const { bot } = await makeBot(dispatchResult, 'success', {
      recordDeltaHedge,
      pendingSwapStore: store,
      hedgeJournal: journal,
      sfpmVenue: {
        coordinator: {
          evaluate: vi.fn(),
          quoteSwap: vi.fn(async () => ({ amountOut: 490n, swapPoolTick: 0 })),
        },
        sfpmExecutor: {
          simulate: vi.fn(async () => undefined),
          execute: sfpmExecute,
          readWalletBalances: vi.fn(async () => ({
            token0: { token: 0n, native: 0n, total: 0n },
            token1: { token: 0n, native: 0n, total: 0n },
          })),
          redepositWalletBalances: vi.fn(),
        },
      },
    })

    expect(await bot.runCycle('recovery-1')).toBe('error')
    expect(await bot.runCycle('recovery-2')).toBe('complete')
    expect(sfpmExecute).toHaveBeenCalledOnce()
    expect(vi.mocked(computeHedgePlan)).not.toHaveBeenCalled()
    expect(store.clear).toHaveBeenCalledTimes(2)
    expect(pending).toBeNull()
    expect(journal.begin).toHaveBeenCalledWith('sfpm_swap')
    expect(recordDeltaHedge).toHaveBeenCalledOnce()
  })
})

describe('HedgerBot hedge classification', () => {
  it('treats unjournaled width-zero loans as hedge positions', async () => {
    const { bot } = await makeBot(
      {
        transactionHash: null,
        receipt: null,
        openedTokenId: null,
        closedTokenIds: [],
        dryRun: true,
      },
      'success',
      {
        hedgeJournal: {
          begin: vi.fn(),
          observeTransaction: vi.fn(),
          recordBroadcastAttempt: vi.fn(),
          confirm: vi.fn(),
          fail: vi.fn(),
          recover: vi.fn(async () => ({ held: [] })),
          hasPendingIntent: () => false,
          checkpoint: () => ({}),
        },
      },
    )
    await bot.runCycle('c1')

    expect(vi.mocked(computeHedgePlan).mock.calls[0][0].hedgePositions).toEqual(positionsOnChain)
  })

  it('dry-run continues to leave on-chain loans unchanged', async () => {
    const { bot } = await makeBot(
      {
        transactionHash: null,
        receipt: null,
        openedTokenId: null,
        closedTokenIds: [7n],
        dryRun: true,
      },
      'success',
    )
    await bot.runCycle('c1')
    await bot.runCycle('c2')
    expect(vi.mocked(readHedgeSnapshot)).toHaveBeenCalledTimes(2)
    // The second cycle re-reads the on-chain loans and plans against them.
    expect(vi.mocked(computeHedgePlan).mock.calls[1][0].hedgePositions).toEqual(positionsOnChain)
  })

  it('a reverted dispatch returns an error outcome without removing on-chain loans', async () => {
    const { bot } = await makeBot(
      {
        transactionHash: '0x01',
        receipt: null,
        openedTokenId: null,
        closedTokenIds: [7n],
        dryRun: false,
      },
      'reverted',
    )
    expect(await bot.runCycle('c1')).toBe('error')
    expect(await bot.runCycle('c2')).toBe('error')
    expect(vi.mocked(computeHedgePlan)).toHaveBeenCalledTimes(2)
    // The reverted dispatch must not strip the on-chain loans from the re-plan.
    expect(vi.mocked(computeHedgePlan).mock.calls[1][0].hedgePositions).toEqual(positionsOnChain)
  })

  it('a successful dispatch uses the next on-chain position snapshot', async () => {
    vi.mocked(readHedgeSnapshot)
      .mockResolvedValueOnce(snapshot(positionsOnChain, []))
      .mockResolvedValueOnce(snapshot([positionsOnChain[1]], [positionsOnChain[1]]))
    const { bot, publicClient } = await makeBot(
      {
        transactionHash: '0x01',
        receipt: null,
        openedTokenId: null,
        closedTokenIds: [7n],
        dryRun: false,
      },
      'success',
    )
    await bot.runCycle('c1')
    await bot.runCycle('c2')
    expect(publicClient.waitForTransactionReceipt).not.toHaveBeenCalled()
    expect(vi.mocked(computeHedgePlan).mock.calls[1][0].hedgePositions).toEqual([
      positionsOnChain[1],
    ])
  })
})

describe('HedgerBot deleverage path', () => {
  const optionLeg = { width: 60n } as never
  const optionPos = { tokenId: 5n, legs: [optionLeg], positionSize: 50n, tickAtMint: 0n }
  const withOption = () => snapshot([optionPos, positionsOnChain[0]], [positionsOnChain[0]])

  const okResult = {
    transactionHash: '0x01',
    receipt: {
      status: 'success',
      transactionHash: '0x01',
      blockNumber: 123n,
      blockHash: `0x${'ab'.repeat(32)}`,
    },
    openedTokenId: null,
    closedTokenIds: [5n],
    dryRun: false,
  } as unknown as HedgeExecutionResult

  /** previewFinalState → healthy post close+rehedge buffer (10000bps). */
  const previewHealthy = vi.fn(async () => ({
    success: true as const,
    margin: {
      collateralBalance0: 10_000n,
      requiredCollateral0: 5_000n,
      collateralBalance1: 10_000n,
      requiredCollateral1: 5_000n,
    },
  }))

  it('closes options via the deleverager role, then rehedges via the loan role', async () => {
    vi.mocked(readHedgeSnapshot).mockResolvedValue(withOption())
    vi.mocked(assessSafety).mockReturnValue({
      safe: false,
      verdict: 'deleverage',
      reasons: ['account is liquidatable'],
      isLiquidatable: true,
      paused: false,
    })
    // Rehedge plan (used for the composite sim AND the in-cycle rehedge): burn loan 7n only.
    vi.mocked(computeHedgePlan).mockReturnValue({
      ...(closeSevenPlan as object),
    } as never)

    const deleveragerExecute = vi.fn(async (_intent: unknown) => okResult)
    const { bot, execute: loanExecute } = await makeBot(okResult, 'success', {
      deleveragerExecutor: {
        kind: 'same-pool-loan',
        previewFinalState: previewHealthy,
        execute: deleveragerExecute,
      } as unknown as HedgeExecutor,
    })

    await bot.runCycle('c1')

    // Option burn went through the deleverager role...
    expect(deleveragerExecute).toHaveBeenCalledTimes(1)
    expect(deleveragerExecute.mock.calls[0][0]).toMatchObject({
      action: 'deleverage_options',
      closeTokenIds: [5n],
    })
    // ...and the freed delta was re-hedged in-cycle through the loan role.
    expect(loanExecute).toHaveBeenCalledTimes(1)
    expect(loanExecute.mock.calls[0][0]).toMatchObject({ closeTokenIds: [7n] })
  })

  it('defers the in-cycle rehedge mint while the pool is paused', async () => {
    vi.mocked(readHedgeSnapshot).mockResolvedValue(withOption())
    vi.mocked(assessSafety).mockReturnValue({
      safe: false,
      verdict: 'deleverage',
      reasons: ['pool is paused (close-only)'],
      isLiquidatable: true,
      paused: true,
    })
    // Rehedge plan that would MINT (openTokenId set) — must be deferred while paused.
    vi.mocked(computeHedgePlan).mockReturnValue({
      ...(consolidatePlan as object),
    } as never)

    const deleveragerExecute = vi.fn(async (_intent: unknown) => okResult)
    const notify = vi.fn(async (_message: unknown) => undefined)
    const { bot, execute: loanExecute } = await makeBot(okResult, 'success', {
      notifier: { notify },
      deleveragerExecutor: {
        kind: 'same-pool-loan',
        previewFinalState: previewHealthy,
        execute: deleveragerExecute,
      } as unknown as HedgeExecutor,
    })

    await bot.runCycle('c1')

    expect(deleveragerExecute).toHaveBeenCalledTimes(1) // burn still lands while paused
    expect(loanExecute).not.toHaveBeenCalled() // rehedge mint deferred
    expect(notify.mock.calls.some((c) => String(c[0]).includes('paused'))).toBe(true)
  })
})

describe('HedgerBot per-cycle pending intent recovery', () => {
  const okResult = {
    transactionHash: '0x01',
    receipt: {
      status: 'success',
      transactionHash: '0x01',
      blockNumber: 123n,
      blockHash: `0x${'ab'.repeat(32)}`,
    },
    openedTokenId: null,
    closedTokenIds: [7n],
    dryRun: false,
  } as unknown as HedgeExecutionResult

  const heldEntry = {
    id: '00000000-0000-4000-8000-00000000dead',
    action: 'open' as const,
    nonce: 4,
    lastHash: `0x${'aa'.repeat(32)}` as const,
    blocksSinceSubmit: 10n,
    blocksRemaining: 54n,
  }

  function journalFake(overrides: Partial<BotDeps['hedgeJournal']> = {}) {
    return {
      begin: vi.fn(() => '00000000-0000-4000-8000-000000000001'),
      observeTransaction: vi.fn(),
      recordBroadcastAttempt: vi.fn(),
      confirm: vi.fn(),
      fail: vi.fn(),
      recover: vi.fn(async () => ({ held: [] })),
      hasPendingIntent: vi.fn(() => false),
      checkpoint: () => ({}),
      ...overrides,
    } satisfies BotDeps['hedgeJournal']
  }

  it('holds the cycle gracefully while a pending intent is still in flight', async () => {
    let pendingSwap: { dispatchIntentId: string; sellToken0: boolean; amount: bigint } | null = null
    const clearPendingSwap = vi.fn(() => {
      pendingSwap = null
    })
    const journal = journalFake({
      hasPendingIntent: vi.fn(() => true),
      recover: vi.fn(async () => ({ held: [heldEntry] })),
    })
    const notify = vi.fn(async (_message: unknown) => undefined)
    const { bot, execute } = await makeBot(okResult, 'success', {
      hedgeJournal: journal,
      notifier: { notify },
      pendingSwapStore: {
        read: () => pendingSwap,
        save: (value) => {
          pendingSwap = value
        },
        clear: clearPendingSwap,
      },
      sfpmVenue: {
        coordinator: {
          evaluate: vi.fn(async () => null),
          quoteSwap: vi.fn(async () => null),
        },
        sfpmExecutor: { simulate: vi.fn(), execute: vi.fn() } as never,
      },
    })
    pendingSwap = { dispatchIntentId: heldEntry.id, sellToken0: true, amount: 100n }
    vi.mocked(readHedgeSnapshot).mockClear()

    const outcome = await bot.runCycle('c1')

    expect(outcome).toBe('held-pending')
    expect(journal.recover).toHaveBeenLastCalledWith(expect.anything(), { scope: 'pending' })
    expect(readHedgeSnapshot).not.toHaveBeenCalled()
    expect(execute).not.toHaveBeenCalled()
    expect(notify).not.toHaveBeenCalled()
    expect(clearPendingSwap).not.toHaveBeenCalled()
    expect(pendingSwap).not.toBeNull()
  })

  it('resolves a recoverable pending intent in-process and completes the cycle', async () => {
    let pending = true
    const journal = journalFake({
      hasPendingIntent: vi.fn(() => pending),
      recover: vi.fn(async () => {
        pending = false
        return { held: [] }
      }),
    })
    const { bot, execute } = await makeBot(okResult, 'success', { hedgeJournal: journal })
    pending = true

    const outcome = await bot.runCycle('c1')

    expect(outcome).toBe('complete')
    expect(execute).toHaveBeenCalledTimes(1)
  })

  it('treats a transient RPC failure during recovery as a hold, not an error', async () => {
    const journal = journalFake()
    const notify = vi.fn(async (_message: unknown) => undefined)
    const { bot } = await makeBot(okResult, 'success', {
      hedgeJournal: journal,
      notifier: { notify },
    })
    vi.mocked(journal.hasPendingIntent).mockReturnValue(true)
    vi.mocked(journal.recover).mockImplementation(async () => {
      throw Object.assign(new Error('socket hang up'), { retryable: true })
    })

    expect(await bot.runCycle('c1')).toBe('held-pending')
    expect(notify).not.toHaveBeenCalled()
  })

  it('alerts once (not per cycle) on a persistent recovery invariant failure', async () => {
    const journal = journalFake()
    const notify = vi.fn(async (_message: unknown) => undefined)
    const { bot } = await makeBot(okResult, 'success', {
      hedgeJournal: journal,
      notifier: { notify },
    })
    vi.mocked(journal.hasPendingIntent).mockReturnValue(true)
    vi.mocked(journal.recover).mockImplementation(async () => {
      throw new Error('mined replacement does not match the durable hedge transaction identity')
    })

    expect(await bot.runCycle('c1')).toBe('error')
    expect(await bot.runCycle('c2')).toBe('error')
    expect(notify).toHaveBeenCalledTimes(1)
  })

  it('soft-holds an unquotable pending SFPM swap until a quote becomes available', async () => {
    let pendingSwap: { dispatchIntentId: string; sellToken0: boolean; amount: bigint } | null = null
    const store = {
      read: () => pendingSwap,
      save: (value: typeof pendingSwap) => {
        pendingSwap = value
      },
      clear: () => {
        pendingSwap = null
      },
    }
    const notify = vi.fn(async (_message: unknown) => undefined)
    const quoteSwap = vi
      .fn()
      .mockResolvedValueOnce(null)
      .mockResolvedValueOnce(null)
      .mockResolvedValue({ amountOut: 90n, swapPoolTick: 0 })
    const executePendingSwap = vi.fn(async () => ({
      transactionHash: '0x02' as const,
      receipt: {
        status: 'success',
        transactionHash: '0x02',
        blockNumber: 124n,
        blockHash: `0x${'cd'.repeat(32)}`,
      } as never,
      amountIn: 100n,
      amountOut: 90n,
      dryRun: false,
    }))
    const { bot, execute } = await makeBot(okResult, 'success', {
      notifier: { notify },
      pendingSwapStore: store as never,
      sfpmVenue: {
        coordinator: {
          evaluate: vi.fn(async () => null),
          quoteSwap,
        },
        sfpmExecutor: {
          simulate: vi.fn(async () => undefined),
          execute: executePendingSwap,
        } as never,
      },
    })
    pendingSwap = { dispatchIntentId: 'intent-1', sellToken0: true, amount: 100n }

    expect(await bot.runCycle('c1')).toBe('held-pending')
    expect(await bot.runCycle('c2')).toBe('held-pending')
    expect(await bot.runCycle('c3')).toBe('complete')
    expect(execute).not.toHaveBeenCalled()
    expect(executePendingSwap).toHaveBeenCalledOnce()
    expect(pendingSwap).toBeNull()
    expect(notify).toHaveBeenCalledTimes(2)
  })
})
