import type { Account, PublicClient } from 'viem'
import { beforeEach, describe, expect, it, vi } from 'vitest'

import type { HedgerBotConfig } from './config'
import type { HedgeExecutionResult, HedgeExecutor } from './executor/types'
import { computeHedgePlan } from './hedge/decision'
import { assessSafety } from './hedge/safety'
import { readHedgeSnapshot } from './hedge/snapshot'
import { HedgerBot } from './hedgerBot'
import { type RolesExecutor, TxNotMinedError } from './safe/rolesExecutor'

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
      healthStatus: 'active',
      currentTick: 0n,
      poolKey: { tickSpacing: 10 },
      metadata: {
        token0Decimals: 18n,
        token1Decimals: 6n,
        token0Symbol: 'WETH',
        token1Symbol: 'USDC',
      },
    },
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
    skippedCollidingTokenIds: [],
    currentTick: 0n,
    slippageBps: 30n,
  },
} as never

/** A consolidation that burns both old loans before minting one replacement. */
const consolidatePlan = {
  action: 'consolidate',
  mints: [{ tokenType: 1n, size: 20n }],
  burns: [7n, 8n],
  swapAtMint: false,
  H: -20n,
  Hstar: -20n,
  driftBps: 0n,
  triggers: { drift: false, overCap: true, signFlip: false },
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
} as never

type BotDeps = ConstructorParameters<typeof HedgerBot>[0]

async function makeBot(
  executeResult: HedgeExecutionResult,
  receiptStatus: 'success' | 'reverted',
  overrides: Partial<
    Pick<BotDeps, 'executor' | 'deleveragerExecutor' | 'notifier' | 'gasPolicy' | 'hedgeJournal'>
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
    rolesExecutor: { preflight: vi.fn(async () => undefined) } as unknown as RolesExecutor,
    notifier,
    gasPolicy: overrides.gasPolicy ?? openGasPolicy,
    // Unused here: readHedgeSnapshot (the only storage consumer) is mocked.
    storage: {} as never,
    hedgeJournal: overrides.hedgeJournal ?? {
      begin: vi.fn(),
      observeTransaction: vi.fn(),
      confirm: vi.fn(),
      fail: vi.fn(),
      recover: vi.fn(async () => undefined),
      checkpoint: () => ({}),
    },
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
    const notify = vi.fn(async () => undefined)
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

describe('HedgerBot stuck dispatch (TxNotMinedError)', () => {
  it('alerts once and leaves the tracked hedge set untouched', async () => {
    const notify = vi.fn(async () => undefined)
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
          confirm: vi.fn(),
          fail: vi.fn(),
          recover: vi.fn(async () => undefined),
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

    const deleveragerExecute = vi.fn(async () => okResult)
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

    const deleveragerExecute = vi.fn(async () => okResult)
    const notify = vi.fn(async () => undefined)
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
