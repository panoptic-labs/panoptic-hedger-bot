/**
 * Fork test for the setup wizard's on-chain core: deploy Safe + Roles, verify
 * the loan-only scope, and validate the generated .env — against the REAL
 * mainnet Safe/Zodiac infrastructure and a real PanopticPool.
 *
 * Prerequisites:
 *   1. export FORK_URL=<mainnet RPC>
 *   2. anvil --fork-url $FORK_URL   (defaults to 127.0.0.1:8545)
 *   3. pnpm test scripts/setup.fork.test.ts
 *
 * Skips automatically when no fork node is reachable.
 */

import {
  type PublicClient,
  createPublicClient,
  createTestClient,
  createWalletClient,
  http,
  parseEther,
} from 'viem'
import { generatePrivateKey, privateKeyToAccount } from 'viem/accounts'
import { mainnet } from 'viem/chains'
import { beforeAll, describe, expect, it } from 'vitest'

import { parseHedgerBotConfig } from '../src/config'
import { rolesModifierV2Abi } from '../src/safe/rolesAbi'
import {
  buildConfigureCalls,
  buildSafeSetupInitializer,
  deployRolesModifier,
  deploySafeAndRoles,
  extractEventAddress,
} from './lib/deployCore'
import { renderEnvFile } from './lib/renderEnv'
import { execFromSoleOwner } from './lib/safeExec'
import { getSafeZodiacAddresses } from './lib/safeZodiacRegistry'
import { fetchProxyCreationCode, makeSafeAddressPredictor } from './lib/vanitySafe'
import { verifyLoanOnlyScope } from './lib/verifyScope'

const RPC_URL = 'http://127.0.0.1:8545'
const CHAIN_ID = 1
// The scope targets this address; the loan-only assertion checks the tokenId
// width fields in dispatch arg0 BEFORE any call to the pool, so it does not
// require a live PanopticPool at this address on the fork.
const POOL_ADDRESS = '0x00000000563b70d704f4c6675a5f6ac989fbae13' as `0x${string}`
// Synthetic 64-bit poolId — only seeds the probe tokenId builders; the Roles
// Bitmask on the width fields is independent of the poolId value.
const SYNTHETIC_POOL_ID = 0x3c08ae4977f78dn

async function forkReachable(): Promise<boolean> {
  try {
    await createPublicClient({ chain: mainnet, transport: http(RPC_URL) }).getBlockNumber()
    return true
  } catch {
    return false
  }
}

const available = await forkReachable()

describe.skipIf(!available)('hedger-bot setup core (mainnet fork)', () => {
  let publicClient: PublicClient
  const deployerKey = generatePrivateKey()
  const botKey = generatePrivateKey()
  const deployer = privateKeyToAccount(deployerKey)
  const bot = privateKeyToAccount(botKey)
  const roleKey = `0x${'11'.repeat(32)}` as `0x${string}`

  beforeAll(async () => {
    publicClient = createPublicClient({ chain: mainnet, transport: http(RPC_URL) })
    const testClient = createTestClient({ chain: mainnet, mode: 'anvil', transport: http(RPC_URL) })
    await testClient.setBalance({ address: deployer.address, value: parseEther('100') })
  })

  it('deploys, scopes, verifies the loan-only boundary, and renders a valid .env', async () => {
    const addresses = getSafeZodiacAddresses(CHAIN_ID)
    const walletClient = createWalletClient({
      account: deployer,
      chain: mainnet,
      transport: http(RPC_URL),
    })

    const finalOwner = privateKeyToAccount(generatePrivateKey()).address
    const result = await deploySafeAndRoles({
      publicClient,
      walletClient,
      botAddress: bot.address,
      poolAddress: POOL_ADDRESS,
      roleKey,
      addresses,
      saltNonce: 424242n,
      // Exercise the à-la-carte role scoping end-to-end against a live modifier.
      extraRoles: [
        { kind: 'deleverager', member: privateKeyToAccount(generatePrivateKey()).address },
        { kind: 'roller', member: privateKeyToAccount(generatePrivateKey()).address, sizeCap: 0n },
      ],
      // Burner deploys, then hands Safe ownership to a separate EOA.
      finalSafeOwner: finalOwner,
      log: () => {},
    })
    expect(result.safeAddress).toMatch(/^0x[a-fA-F0-9]{40}$/)
    expect(result.rolesModifierAddress).toMatch(/^0x[a-fA-F0-9]{40}$/)
    expect(result.safeOwner).toBe(finalOwner)

    // The vanity miner's CREATE2 predictor must reproduce the exact address the
    // factory emitted (same deployer initializer + salt), or mining would target
    // an address that never gets deployed.
    const proxyCreationCode = await fetchProxyCreationCode(publicClient, addresses.safeProxyFactory)
    const predict = makeSafeAddressPredictor({
      factory: addresses.safeProxyFactory,
      singleton: addresses.safeSingleton,
      initializer: buildSafeSetupInitializer(deployer.address),
      proxyCreationCode,
    })
    expect(predict(424242n).toLowerCase()).toBe(result.safeAddress.toLowerCase())

    // Ownership was handed off: the final owner owns the Safe, the burner does not.
    const owners = (await publicClient.readContract({
      address: result.safeAddress,
      abi: [
        {
          type: 'function',
          name: 'getOwners',
          stateMutability: 'view',
          inputs: [],
          outputs: [{ type: 'address[]' }],
        },
      ],
      functionName: 'getOwners',
    })) as readonly `0x${string}`[]
    expect(owners.map((o) => o.toLowerCase())).toEqual([finalOwner.toLowerCase()])
    expect(owners.map((o) => o.toLowerCase())).not.toContain(deployer.address.toLowerCase())

    // Roles modifier wired to the Safe (mirrors rolesExecutor.preflight()).
    const code = await publicClient.getCode({ address: result.rolesModifierAddress })
    expect(code && code !== '0x').toBeTruthy()
    const [avatar, target] = await Promise.all([
      publicClient.readContract({
        address: result.rolesModifierAddress,
        abi: rolesModifierV2Abi,
        functionName: 'avatar',
      }),
      publicClient.readContract({
        address: result.rolesModifierAddress,
        abi: rolesModifierV2Abi,
        functionName: 'target',
      }),
    ])
    expect(avatar.toLowerCase()).toBe(result.safeAddress.toLowerCase())
    expect(target.toLowerCase()).toBe(result.safeAddress.toLowerCase())

    // Batched path: the Roles modifier is owned by the Safe from birth (no
    // standing EOA admin, and no separate transferOwnership tx).
    const rolesOwner = (await publicClient.readContract({
      address: result.rolesModifierAddress,
      abi: rolesModifierV2Abi,
      functionName: 'owner',
    })) as `0x${string}`
    expect(rolesOwner.toLowerCase()).toBe(result.safeAddress.toLowerCase())

    // The Roles module is enabled on the Safe (the configure batch landed).
    const moduleEnabled = (await publicClient.readContract({
      address: result.safeAddress,
      abi: [
        {
          type: 'function',
          name: 'isModuleEnabled',
          stateMutability: 'view',
          inputs: [{ name: 'module', type: 'address' }],
          outputs: [{ type: 'bool' }],
        },
      ],
      functionName: 'isModuleEnabled',
      args: [result.rolesModifierAddress],
    })) as boolean
    expect(moduleEnabled).toBe(true)

    // Idempotent resume: re-running with the discovered addresses is a clean
    // no-op — it must NOT revert (the deployer is no longer the Safe owner, so a
    // re-sent configure batch would fail; the module-enabled short-circuit skips
    // it) and returns the same end state.
    const resumed = await deploySafeAndRoles({
      publicClient,
      walletClient,
      botAddress: bot.address,
      poolAddress: POOL_ADDRESS,
      roleKey,
      addresses,
      saltNonce: 424242n,
      finalSafeOwner: finalOwner,
      known: {
        safeAddress: result.safeAddress,
        rolesModifierAddress: result.rolesModifierAddress,
      },
      log: () => {},
    })
    expect(resumed.safeAddress.toLowerCase()).toBe(result.safeAddress.toLowerCase())
    expect(resumed.rolesModifierAddress.toLowerCase()).toBe(
      result.rolesModifierAddress.toLowerCase(),
    )

    // The security boundary: loan allowed, option blocked.
    await expect(
      verifyLoanOnlyScope({
        publicClient,
        rolesModifierAddress: result.rolesModifierAddress,
        botAddress: bot.address,
        roleKey,
        poolAddress: POOL_ADDRESS,
        poolId: SYNTHETIC_POOL_ID,
        log: () => {},
      }),
    ).resolves.toBeUndefined()

    // Generated .env round-trips through the config schema.
    const body = renderEnvFile({
      CHAIN_ID,
      RPC_URL,
      POOL_ADDRESS,
      SAFE_ADDRESS: result.safeAddress,
      ROLES_MODIFIER_ADDRESS: result.rolesModifierAddress,
      ROLE_KEY: result.roleKey,
      BOT_PRIVATE_KEY: botKey,
      ASSET_INDEX: 1,
      DRY_RUN: true,
    })
    const env: NodeJS.ProcessEnv = {}
    for (const line of body.split('\n')) {
      const t = line.trim()
      if (!t || t.startsWith('#')) continue
      const eq = t.indexOf('=')
      env[t.slice(0, eq)] = t.slice(eq + 1)
    }
    expect(() => parseHedgerBotConfig(env)).not.toThrow()
  }, 120_000)

  // Existing-Safe path: deploy a clean 1-of-1 Safe the "user" owns, then run the
  // building blocks configureExistingSafe composes (deploy modifier + build
  // owner calls + owner executes them), and prove additive multi-pool scoping.
  it('wires a clean user-owned Safe and adds a second pool (additive scope)', async () => {
    const addresses = getSafeZodiacAddresses(CHAIN_ID)
    const testClient = createTestClient({ chain: mainnet, mode: 'anvil', transport: http(RPC_URL) })

    // A fresh 1-of-1 owner (hot wallet, so the test can sign) + a funded bot.
    const ownerKey = generatePrivateKey()
    const owner = privateKeyToAccount(ownerKey)
    await testClient.setBalance({ address: owner.address, value: parseEther('100') })
    await testClient.setBalance({ address: bot.address, value: parseEther('100') })
    const ownerWallet = createWalletClient({
      account: owner,
      chain: mainnet,
      transport: http(RPC_URL),
    })
    const botWallet = createWalletClient({ account: bot, chain: mainnet, transport: http(RPC_URL) })

    // 1. Deploy a clean Safe (owner = the user, threshold 1) via the factory.
    const factoryAbi = [
      {
        type: 'function',
        name: 'createProxyWithNonce',
        stateMutability: 'nonpayable',
        inputs: [
          { name: '_singleton', type: 'address' },
          { name: 'initializer', type: 'bytes' },
          { name: 'saltNonce', type: 'uint256' },
        ],
        outputs: [{ name: 'proxy', type: 'address' }],
      },
      {
        type: 'event',
        name: 'ProxyCreation',
        inputs: [
          { name: 'proxy', type: 'address', indexed: true },
          { name: 'singleton', type: 'address', indexed: false },
        ],
      },
    ] as const
    const createHash = await ownerWallet.writeContract({
      address: addresses.safeProxyFactory,
      abi: factoryAbi,
      functionName: 'createProxyWithNonce',
      args: [addresses.safeSingleton, buildSafeSetupInitializer(owner.address), 987654n],
    })
    const createReceipt = await publicClient.waitForTransactionReceipt({ hash: createHash })
    const safeAddress = extractEventAddress(
      createReceipt.logs,
      factoryAbi,
      'ProxyCreation',
      'proxy',
    )

    // 2. Bot deploys the Roles modifier (permissionless), owner/avatar/target = Safe.
    const existingRoleKey = `0x${'22'.repeat(32)}` as `0x${string}`
    const modifier = await deployRolesModifier({
      publicClient,
      walletClient: botWallet,
      addresses,
      safeAddress,
      saltNonce: 987654n,
      log: () => {},
    })

    // Helper: the owner executes each printed configure call as a plain CALL.
    const execAsOwner = async (calls: ReturnType<typeof buildConfigureCalls>): Promise<void> => {
      for (const c of calls) {
        await execFromSoleOwner({
          publicClient,
          walletClient: ownerWallet,
          safeAddress,
          to: c.to,
          data: c.data,
          simulate: true,
          log: () => {},
        })
      }
    }

    // 3. Enable + assign + scope pool A (first-time: includeEnableModule true).
    await execAsOwner(
      buildConfigureCalls({
        safeAddress,
        rolesModifierAddress: modifier,
        botAddress: bot.address,
        roleKey: existingRoleKey,
        poolAddress: POOL_ADDRESS,
        includeEnableModule: true,
      }),
    )
    await expect(
      verifyLoanOnlyScope({
        publicClient,
        rolesModifierAddress: modifier,
        botAddress: bot.address,
        roleKey: existingRoleKey,
        poolAddress: POOL_ADDRESS,
        poolId: SYNTHETIC_POOL_ID,
        log: () => {},
      }),
    ).resolves.toBeUndefined()

    // 4. Add a SECOND pool to the same modifier/role (module already enabled).
    const POOL_B = '0x00000000000000000000000000000000000000b2' as `0x${string}`
    const POOL_B_ID = 0x1122334455667n
    await execAsOwner(
      buildConfigureCalls({
        safeAddress,
        rolesModifierAddress: modifier,
        botAddress: bot.address,
        roleKey: existingRoleKey,
        poolAddress: POOL_B,
        includeEnableModule: false,
      }),
    )

    // Both pools are scoped — adding B did not un-scope A (additive Roles v2).
    for (const [pool, poolId] of [
      [POOL_ADDRESS, SYNTHETIC_POOL_ID],
      [POOL_B, POOL_B_ID],
    ] as const) {
      await expect(
        verifyLoanOnlyScope({
          publicClient,
          rolesModifierAddress: modifier,
          botAddress: bot.address,
          roleKey: existingRoleKey,
          poolAddress: pool,
          poolId,
          log: () => {},
        }),
      ).resolves.toBeUndefined()
    }
  }, 120_000)
})
