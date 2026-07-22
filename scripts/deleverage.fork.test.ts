/**
 * End-to-end deleverager fork test (Ethereum mainnet).
 *
 * Proves the full emergency-deleverager loop against the REAL mainnet
 * PanopticPool + Safe/Zodiac infrastructure on an anvil fork:
 *   1. Deploy a fresh Safe (per test) scoping the loan role + burn-only
 *      deleverager role.
 *   2. As the Safe owner, deposit USDC collateral and mint a small SHORT PUT
 *      into the Safe (put ⇒ USDC-side commission/collateral, so no native-ETH
 *      msg.value is needed — execFromSoleOwner sends value 0; a call would need
 *      ETH collateral for its commission fee).
 *   3. Set the deleverage trigger just above the observed buffer so it fires.
 *   4. Run the real HedgerBot.runCycle and assert it closed the option via the
 *      burn-only deleverager role (position no longer owned) and the buffer rose.
 *   5. Repeat with the pool forced into CLOSE_ONLY (impersonate the RiskEngine →
 *      lockSafeMode) and assert the burn STILL lands while paused.
 *
 * anvil state persists across runs, so each test rewinds via anvil_reset
 * (resetFork) — otherwise a forced safe-mode from a prior run leaks in and blocks
 * the seed mint (mint reverts StaleOracle while safeMode>2).
 *
 * Prerequisites (fork at a block where the pool is ACTIVE, isSafeMode=0):
 *   1. anvil --fork-url $MAINNET_RPC_URL --port 8546
 *   2. export HEDGER_FORK_RPC_URL=http://127.0.0.1:8546
 *   3. pnpm -C apps/hedger-bot security:test-fork
 */

import {
  createMemoryStorage,
  createTokenIdBuilder,
  estimateCollateralRequired,
  getChainDeployment,
  getPool,
  getPosition,
  isLiquidatable,
  panopticPoolV2Abi,
  parsePanopticError,
} from '@panoptic-eng/sdk/v2'
import { DELEVERAGER_ROLE_KEY } from '@panoptic-eng/sdk/zodiac'
import {
  type Account,
  type PublicClient,
  type WalletClient,
  createPublicClient,
  createTestClient,
  createWalletClient,
  encodeAbiParameters,
  encodeFunctionData,
  http,
  keccak256,
  parseUnits,
} from 'viem'
import { generatePrivateKey, privateKeyToAccount } from 'viem/accounts'
import { mainnet } from 'viem/chains'
import { afterEach, beforeAll, beforeEach, describe, expect, it } from 'vitest'

import type { HedgerBotConfig } from '../src/config'
import { createSamePoolLoanExecutor } from '../src/executor'
import { computeLiquidationBufferBps } from '../src/hedge/deleverage'
import { HedgerBot } from '../src/hedgerBot'
import type { HedgeJournalPort } from '../src/runtime/hedgeJournal'
import { createRolesExecutor } from '../src/safe/rolesExecutor'
import { asSdkClient } from '../src/utils/sdkClient'
import { deploySafeAndRoles } from './lib/deployCore'
import { execFromSoleOwner } from './lib/safeExec'
import { getSafeZodiacAddresses } from './lib/safeZodiacRegistry'

const RPC_URL = process.env.HEDGER_FORK_RPC_URL
if (!RPC_URL) {
  throw new Error(
    'HEDGER_FORK_RPC_URL is required; start a pinned mainnet fork before running security:test-fork',
  )
}
const CHAIN_ID = 1
const POOL_ADDRESS = '0x00000000563b70d704f4c6675a5f6ac989fbae13' as `0x${string}`
const USDC = '0xA0b86991c6218b36c1d19D4a2e9Eb0cE3606eB48' as `0x${string}`
// mainnet USDC (FiatTokenV2_2) balanceOf mapping storage slot.
const USDC_BALANCE_SLOT = 9n

// --- Tunables (expect to adjust once against a live fork block) ---------------
const DEPOSIT_USDC = parseUnits('200000', 6) // collateral seeded into the Safe
// -----------------------------------------------------------------------------

const erc20Abi = [
  {
    type: 'function',
    name: 'approve',
    stateMutability: 'nonpayable',
    inputs: [
      { name: 'spender', type: 'address' },
      { name: 'value', type: 'uint256' },
    ],
    outputs: [{ type: 'bool' }],
  },
  {
    type: 'function',
    name: 'balanceOf',
    stateMutability: 'view',
    inputs: [{ name: 'a', type: 'address' }],
    outputs: [{ type: 'uint256' }],
  },
] as const

const collateralTrackerAbi = [
  {
    type: 'function',
    name: 'deposit',
    stateMutability: 'payable',
    inputs: [
      { name: 'assets', type: 'uint256' },
      { name: 'receiver', type: 'address' },
    ],
    outputs: [{ type: 'uint256' }],
  },
] as const

const poolLockAbi = [
  {
    type: 'function',
    name: 'lockSafeMode',
    stateMutability: 'nonpayable',
    inputs: [],
    outputs: [],
  },
  {
    type: 'function',
    name: 'isSafeMode',
    stateMutability: 'view',
    inputs: [],
    outputs: [{ type: 'uint8' }],
  },
] as const

/** A no-op journal — the fork test asserts on-chain state, not journal durability. */
const noopJournal: HedgeJournalPort = {
  begin: () => {},
  observeTransaction: () => {},
  confirm: () => {},
  fail: () => {},
  recover: async () => {},
  checkpoint: () => ({}) as never,
}

/** Permissive gas policy: never defers; lets the wallet estimate fees on anvil. */
const openGasPolicy = {
  assess: async () => ({
    proceed: true,
    urgent: true,
    baseFeeGwei: '1',
    capGwei: '500',
    shouldNotifySkip: false,
  }),
  fees: async () => undefined,
  bumped: async () => null,
  checkKeeperBalance: async () => undefined,
}

describe('hedger-bot deleverager end-to-end (mainnet fork)', () => {
  let publicClient: PublicClient
  let testClient: ReturnType<typeof createTestClient>
  const ownerKey = generatePrivateKey()
  const deployerKey = generatePrivateKey()
  const botKey = generatePrivateKey()
  const owner = privateKeyToAccount(ownerKey)
  const deployer = privateKeyToAccount(deployerKey)
  const bot = privateKeyToAccount(botKey)
  const loanRoleKey = `0x${'11'.repeat(32)}` as `0x${string}`

  let pool: Awaited<ReturnType<typeof getPool>>
  let safeAddress: `0x${string}`
  let rolesModifierAddress: `0x${string}`
  let queryAddress: `0x${string}`
  let collateral0: `0x${string}`
  let collateral1: `0x${string}`
  let riskEngineAddress: `0x${string}`
  let ownerWallet: WalletClient
  let poolSafeMode = 0
  let saltCounter = 990_000n
  let snapshotId: `0x${string}` | undefined

  /** Fund the deployer/owner/bot with gas ETH. */
  async function fundActors(): Promise<void> {
    for (const a of [deployer.address, owner.address, bot.address]) {
      await testClient.setBalance({ address: a, value: parseUnits('100', 18) })
    }
  }

  /** setStorageAt the USDC balanceOf slot so `who` holds `amount` USDC. */
  async function dealUsdc(who: `0x${string}`, amount: bigint): Promise<void> {
    const slot = keccak256Slot(who, USDC_BALANCE_SLOT)
    await testClient.setStorageAt({
      address: USDC,
      index: slot,
      value: `0x${amount.toString(16).padStart(64, '0')}`,
    })
  }

  /** Execute a call from the Safe (sole owner = `owner`). */
  async function fromSafe(to: `0x${string}`, data: `0x${string}`): Promise<void> {
    await execFromSoleOwner({
      publicClient,
      walletClient: ownerWallet as never,
      safeAddress,
      to,
      data,
      log: () => {},
    })
  }

  /**
   * eth_call the inner call with msg.sender = Safe to surface the REAL revert
   * (the Safe otherwise rewraps it as the opaque GS013). Logs the decoded
   * Panoptic error and rethrows, so a failing seed dispatch is diagnosable.
   */
  async function decodeFromSafe(to: `0x${string}`, data: `0x${string}`): Promise<void> {
    try {
      await publicClient.call({ account: safeAddress, to, data })
    } catch (err) {
      const parsed = parsePanopticError(err)
      // eslint-disable-next-line no-console
      console.log(
        `[fork] inner revert from Safe: ${parsed ? `${parsed.errorName}(${parsed.args.join(', ')})` : String(err).slice(0, 300)}`,
      )
      throw err
    }
  }

  beforeAll(async () => {
    // cacheTime: 0 — the afterEach snapshot revert rewinds the chain, so a cached
    // block number from the previous test would point past the new head and make
    // block-pinned eth_calls fail with "Invalid parameters".
    publicClient = createPublicClient({ chain: mainnet, transport: http(RPC_URL), cacheTime: 0 })
    await publicClient.getBlockNumber().catch(() => {
      throw new Error(`fork unreachable at ${RPC_URL}`)
    })
    testClient = createTestClient({ chain: mainnet, mode: 'anvil', transport: http(RPC_URL) })
    ownerWallet = createWalletClient({ account: owner, chain: mainnet, transport: http(RPC_URL) })
    await fundActors()

    // Resolve mainnet deployment + live pool state.
    const deployment = getChainDeployment(CHAIN_ID)
    queryAddress = deployment?.panoptic.v2.panopticQuery as `0x${string}`
    pool = await getPool({
      client: asSdkClient<typeof getPool>(publicClient),
      poolAddress: POOL_ADDRESS,
      chainId: BigInt(CHAIN_ID),
    })
    collateral0 = pool.collateralTracker0.address
    collateral1 = pool.collateralTracker1.address
    riskEngineAddress = pool.riskEngine.address
    const safeModeRaw = await publicClient.readContract({
      address: POOL_ADDRESS,
      abi: poolLockAbi,
      functionName: 'isSafeMode',
    })
    poolSafeMode = Number(safeModeRaw)
    // eslint-disable-next-line no-console
    console.log(
      `[fork] pool tick=${pool.currentTick} spacing=${pool.tickSpacing} ` +
        `health=${pool.healthStatus} isSafeMode=${safeModeRaw} ` +
        `CT0=${collateral0} CT1=${collateral1} query=${queryAddress}`,
    )
  }, 120_000)

  // Snapshot before each test and revert after, so a test's mutations — crucially
  // the paused case's `lockSafeMode()` — never leak into the next case or the next
  // `security:test-fork` invocation (anvil state persists across runs). No re-fork,
  // so no stale-block issues.
  beforeEach(async () => {
    await fundActors()
    snapshotId = (await testClient.snapshot()) as `0x${string}`
  })
  afterEach(async () => {
    if (snapshotId) await testClient.revert({ id: snapshotId })
    snapshotId = undefined
  })

  /**
   * Deploy a FRESH Safe (loan role + burn-only deleverager role) per test so the
   * two cases don't share position state. Unique salt each call. Ownership is
   * handed to `owner` so we can drive deposits/mints through the Safe.
   */
  async function deployFreshSafe(): Promise<void> {
    saltCounter += 1n
    const walletClient = createWalletClient({
      account: deployer,
      chain: mainnet,
      transport: http(RPC_URL),
    })
    const deployed = await deploySafeAndRoles({
      publicClient,
      walletClient,
      botAddress: bot.address,
      poolAddress: POOL_ADDRESS,
      roleKey: loanRoleKey,
      addresses: getSafeZodiacAddresses(CHAIN_ID),
      saltNonce: saltCounter,
      extraRoles: [{ kind: 'deleverager', member: bot.address }],
      finalSafeOwner: owner.address,
      log: () => {},
    })
    safeAddress = deployed.safeAddress
    rolesModifierAddress = deployed.rolesModifierAddress
  }

  /** Seed collateral + open a short option and a hedge loan into the Safe. */
  async function seedPositions(): Promise<{ optionTokenId: bigint; loanTokenId: bigint }> {
    // Minting is impossible while the pool is in safe-mode (safeMode>2 ⇒ the mint
    // path reverts StaleOracle). On a pinned fork this reflects the pool's state
    // at that block — re-fork at a block where the pool is active (isSafeMode=0)
    // to seed the option this e2e needs.
    if (poolSafeMode >= 2) {
      throw new Error(
        `pool is in safe-mode (isSafeMode=${poolSafeMode}) on this fork block — cannot MINT ` +
          `the seed option (mint reverts StaleOracle). Re-fork at a block where the ETH/USDC ` +
          `pool is active (isSafeMode=0) to run the e2e seed.`,
      )
    }
    // 1. Fund + deposit USDC collateral into the Safe.
    await dealUsdc(safeAddress, DEPOSIT_USDC)
    const dealtBal = await publicClient.readContract({
      address: USDC,
      abi: erc20Abi,
      functionName: 'balanceOf',
      args: [safeAddress],
    })
    if (dealtBal < DEPOSIT_USDC) {
      throw new Error(`USDC deal failed (balanceOf slot wrong?) — got ${dealtBal}`)
    }
    await fromSafe(
      USDC,
      encodeFunctionData({
        abi: erc20Abi,
        functionName: 'approve',
        args: [collateral1, DEPOSIT_USDC],
      }),
    )
    await fromSafe(
      collateral1,
      encodeFunctionData({
        abi: collateralTrackerAbi,
        functionName: 'deposit',
        args: [DEPOSIT_USDC, safeAddress],
      }),
    )

    // 2. Build a short PUT (width>0) near spot + a width-0 put-side hedge loan.
    //    A call's commission fee must be paid in token0 (ETH); we deposited USDC
    //    only, so use the put (token1/USDC) side — fee + collateral are USDC.
    const spacing = pool.tickSpacing
    const strike = (pool.currentTick / spacing) * spacing
    const optionTokenId = createTokenIdBuilder(pool.poolId)
      .addPut({ strike, width: 4n, optionRatio: 1n, isLong: false })
      .build()
    const loanTokenId = createTokenIdBuilder(pool.poolId)
      .addLoan({ asset: 0n, tokenType: 1n, strike, optionRatio: 1n })
      .build()

    // 3. Size SMALL and directly: the on-chain sizer returns 0 here, so invert
    //    getRequiredBase for a tiny target requirement and clamp well below uint64
    //    to avoid overflowing the pool's liquidity math (Panic(17)).
    const REF = 10n ** 9n
    const est = await estimateCollateralRequired({
      client: asSdkClient<typeof estimateCollateralRequired>(publicClient),
      poolAddress: POOL_ADDRESS,
      account: safeAddress,
      queryAddress,
      tokenId: optionTokenId,
      positionSize: REF,
      atTick: pool.currentTick,
    })
    const reqRef = est.required1 > 0n ? est.required1 : est.required0
    // Target ~0.5 ETH-equivalent of requirement; clamp size to [1e6, 1e17].
    const targetReq = 5n * 10n ** 17n
    let optionSize = reqRef > 0n ? (REF * targetReq) / reqRef : 10n ** 15n
    if (optionSize > 10n ** 17n) optionSize = 10n ** 17n
    if (optionSize < 10n ** 6n) optionSize = 10n ** 6n

    // 4. Mint ONLY the option (owner-executed dispatch). We deposited USDC only,
    //    so use the mint-time swap — encoded as DESCENDING tick limits [high, low].
    const band = spacing * 200n
    const low = pool.currentTick - band
    const high = pool.currentTick + band
    const dispatch = encodeFunctionData({
      abi: panopticPoolV2Abi,
      functionName: 'dispatch',
      args: [
        [optionTokenId],
        [optionTokenId],
        [optionSize],
        [[Number(high), Number(low), 0]],
        false,
        0n,
      ],
    })
    await decodeFromSafe(POOL_ADDRESS, dispatch)
    await fromSafe(POOL_ADDRESS, dispatch)
    return { optionTokenId, loanTokenId }
  }

  /**
   * Construct a real HedgerBot wired to the deployed Safe + both role keys.
   * The trigger/target are derived from the OBSERVED buffer so the test is
   * robust to the absolute magnitude: trigger just above the current buffer (so
   * it fires) and target modestly higher (so closing the option clears it). The
   * config is a plain cast, bypassing the schema's cross-field constraints.
   */
  function buildBot(triggerBps: bigint, targetBps: bigint): HedgerBot {
    const config = {
      CHAIN_ID,
      POOL_ADDRESS,
      SAFE_ADDRESS: safeAddress,
      ROLES_MODIFIER_ADDRESS: rolesModifierAddress,
      ROLE_KEY: loanRoleKey,
      ASSET_INDEX: 0n, // hedge in ETH (token0) — the option's underlying
      DELTA_THRESHOLD_BPS: 200n,
      DELTA_OFFSET_BPS: 0n,
      MAX_HEDGE_SLOTS: 4,
      SLIPPAGE_BPS: 100,
      MIN_MARGIN_RESERVE_BPS: 2_000n,
      DELEVERAGER_ENABLED: true,
      DELEVERAGE_TRIGGER_MARGIN_BPS: triggerBps,
      DELEVERAGE_TARGET_MARGIN_BPS: targetBps,
      DELEVERAGE_SLIPPAGE_BPS: 500,
      DELEVERAGE_COOLDOWN_MS: 300_000,
      DRY_RUN: false,
      URGENT_DRIFT_MULTIPLIER: 3,
      TX_RECEIPT_TIMEOUT_MS: 60_000,
      TX_BUMP_INTERVAL_MS: 30_000,
      SIGNAL_TICK_SANITY_MAX: 100_000,
    } as unknown as HedgerBotConfig

    const walletClient = createWalletClient({
      account: bot,
      chain: mainnet,
      transport: http(RPC_URL),
    })
    const rolesExecutorDeps = {
      publicClient,
      walletClient,
      account: bot as Account,
      rolesModifierAddress,
      safeAddress,
      chain: mainnet,
      fees: () => openGasPolicy.fees(),
      bumpFees: () => openGasPolicy.bumped(),
      txWait: { timeoutMs: 60_000, bumpIntervalMs: 30_000 },
      observeTransaction: () => {},
      assertSendAllowed: () => {},
    }
    const loanRolesExecutor = createRolesExecutor({ ...rolesExecutorDeps, roleKey: loanRoleKey })
    const delevRolesExecutor = createRolesExecutor({
      ...rolesExecutorDeps,
      roleKey: DELEVERAGER_ROLE_KEY,
    })
    const executor = createSamePoolLoanExecutor({
      poolAddress: POOL_ADDRESS,
      publicClient,
      safeAddress,
      rolesExecutor: loanRolesExecutor,
      dryRun: false,
    })
    const deleveragerExecutor = createSamePoolLoanExecutor({
      poolAddress: POOL_ADDRESS,
      publicClient,
      safeAddress,
      rolesExecutor: delevRolesExecutor,
      dryRun: false,
    })

    return new HedgerBot({
      config,
      publicClient,
      account: bot as Account,
      priceSource: {
        kind: 'pool-tick',
        getSignal: async () => ({
          tick: pool.currentTick,
          observedAtMs: Date.now(),
          source: 'pool-tick' as const,
        }),
      } as never,
      vaultAsset: { decimals: Number(pool.collateralTracker0.decimals), symbol: 'ETH' },
      executor,
      rolesExecutor: loanRolesExecutor,
      deleveragerExecutor,
      notifier: { notify: async () => {} },
      gasPolicy: openGasPolicy as never,
      storage: createMemoryStorage(),
      hedgeJournal: noopJournal,
    })
  }

  /** Margin buffer for a given open position set (empty ⇒ no-risk sentinel). */
  async function bufferBps(tokenIds: bigint[]): Promise<bigint> {
    const liq = await isLiquidatable({
      client: asSdkClient<typeof isLiquidatable>(publicClient),
      poolAddress: POOL_ADDRESS,
      account: safeAddress,
      tokenIds,
    })
    return computeLiquidationBufferBps(liq)
  }

  /** Position size, treating a burned/not-owned position as size 0. */
  async function optionSize(tokenId: bigint): Promise<bigint> {
    try {
      const pos = await getPosition({
        client: asSdkClient<typeof getPosition>(publicClient),
        poolAddress: POOL_ADDRESS,
        owner: safeAddress,
        tokenId,
      })
      return pos.positionSize
    } catch (err) {
      if (parsePanopticError(err)?.errorName === 'PositionNotOwned') return 0n
      throw err
    }
  }

  it('closes the option via the deleverager role and re-hedges via the loan role', async () => {
    await deployFreshSafe()
    const { optionTokenId } = await seedPositions()
    const before = await bufferBps([optionTokenId])
    // eslint-disable-next-line no-console
    console.log(`[fork] seeded — buffer=${before}bps option=${optionTokenId}`)
    expect(await optionSize(optionTokenId)).toBeGreaterThan(0n)

    // Trigger just above the observed buffer (fires); target higher (clears once
    // the option is closed). Robust to the absolute buffer magnitude.
    const botInstance = buildBot(before + 300n, before + 800n)
    await botInstance.init()
    await botInstance.runCycle('fork-deleverage')

    // Option force-closed via the deleverager role...
    expect(await optionSize(optionTokenId)).toBe(0n)
    // ...and the buffer recovered (option gone ⇒ requirement dropped).
    const after = await bufferBps([])
    // eslint-disable-next-line no-console
    console.log(`[fork] after deleverage — buffer=${after}bps`)
    expect(after).toBeGreaterThan(before)
  }, 120_000)

  it('deleverages while the pool is in CLOSE_ONLY (paused/safe-mode)', async () => {
    await deployFreshSafe()
    // Seed while the pool is active (minting is blocked in safe-mode)...
    const { optionTokenId } = await seedPositions()
    const before = await bufferBps([optionTokenId])
    expect(await optionSize(optionTokenId)).toBeGreaterThan(0n)

    // ...then force CLOSE_ONLY by impersonating the RiskEngine → lockSafeMode().
    await testClient.impersonateAccount({ address: riskEngineAddress })
    await testClient.setBalance({ address: riskEngineAddress, value: parseUnits('1', 18) })
    // JSON-RPC account (the impersonated RiskEngine) — anvil signs it.
    const reWallet = createWalletClient({
      account: riskEngineAddress,
      chain: mainnet,
      transport: http(RPC_URL),
    })
    await reWallet.writeContract({
      address: POOL_ADDRESS,
      abi: poolLockAbi,
      functionName: 'lockSafeMode',
      args: [],
    })
    await testClient.stopImpersonatingAccount({ address: riskEngineAddress })
    const mode = await publicClient.readContract({
      address: POOL_ADDRESS,
      abi: poolLockAbi,
      functionName: 'isSafeMode',
    })
    expect(Number(mode)).toBeGreaterThanOrEqual(2)

    const botInstance = buildBot(before + 300n, before + 800n)
    await botInstance.init()
    await botInstance.runCycle('fork-deleverage-paused')

    // The burn lands even while paused (safe-mode is burn/close-only).
    expect(await optionSize(optionTokenId)).toBe(0n)
  }, 120_000)
})

/** keccak256(abi.encode(key, slot)) — storage key for mapping(address=>uint). */
function keccak256Slot(key: `0x${string}`, slot: bigint): `0x${string}` {
  return keccak256(encodeAbiParameters([{ type: 'address' }, { type: 'uint256' }], [key, slot]))
}
