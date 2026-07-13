import 'dotenv/config'

import { createPublicClient, createWalletClient, http } from 'viem'
import { privateKeyToAccount } from 'viem/accounts'

import { defineBotChain } from '../src/utils/chain'
import { deploySafeAndRoles } from './lib/deployCore'
import { ADDRESS_RE, getSafeZodiacAddresses } from './lib/safeZodiacRegistry'

const BYTES32_RE = /^0x[a-fA-F0-9]{64}$/

/**
 * One-time programmatic setup of the hedger-bot on-chain infrastructure:
 *   1. Deploy a Gnosis Safe (owner = deployer EOA, threshold 1).
 *   2. Deploy a Zodiac Roles v2 modifier (owner/avatar/target = the Safe).
 *   3. Enable the modifier as a module on the Safe.
 *   4. Assign the bot EOA to the role and scope it to loan-only dispatch.
 *
 * ⚠️  OPS TOOLING — NOT UNIT-TESTED. Run against an anvil/Tenderly fork of the
 *     target chain and verify the end state (module enabled, role scoped, bot can
 *     mint a loan but not an option) BEFORE running on a real network.
 *
 * Prefer `pnpm setup` (interactive, auto-derives addresses + verifies the scope).
 * This script is the non-interactive, fully env-driven equivalent.
 *
 * Required env:
 *   RPC_URL, CHAIN_ID, DEPLOYER_PRIVATE_KEY (becomes Safe owner + Roles owner),
 *   BOT_ADDRESS, POOL_ADDRESS, ROLE_KEY (bytes32), SALT_NONCE (integer).
 * Safe/Zodiac addresses come from the chain registry (scripts/lib/safeZodiacRegistry.ts);
 * override per-address with SAFE_PROXY_FACTORY, SAFE_SINGLETON,
 * ZODIAC_MODULE_PROXY_FACTORY, ROLES_MASTERCOPY for unlisted chains.
 */

function env(name: string): string {
  const v = process.env[name]
  if (!v) throw new Error(`missing env ${name}`)
  return v
}

/** Read an env var and validate it against `re`, erroring with an example. */
function envMatching(name: string, re: RegExp, expected: string): `0x${string}` {
  const v = env(name)
  if (!re.test(v)) throw new Error(`invalid env ${name}: expected ${expected}, got "${v}"`)
  return v as `0x${string}`
}

async function main(): Promise<void> {
  const chainId = Number(env('CHAIN_ID'))
  const rpcUrl = env('RPC_URL')
  const deployer = privateKeyToAccount(env('DEPLOYER_PRIVATE_KEY') as `0x${string}`)
  const botAddress = envMatching('BOT_ADDRESS', ADDRESS_RE, 'a 20-byte hex address (0x…)')
  const poolAddress = envMatching('POOL_ADDRESS', ADDRESS_RE, 'a 20-byte hex address (0x…)')
  const roleKey = envMatching('ROLE_KEY', BYTES32_RE, 'a 32-byte hex value (0x…)')
  const saltNonceRaw = env('SALT_NONCE')
  if (!/^\d+$/.test(saltNonceRaw)) {
    throw new Error(
      `invalid env SALT_NONCE: expected a non-negative integer, got "${saltNonceRaw}"`,
    )
  }
  const saltNonce = BigInt(saltNonceRaw)
  const addresses = getSafeZodiacAddresses(chainId)

  const chain = defineBotChain(chainId, rpcUrl)
  const publicClient = createPublicClient({ chain, transport: http(rpcUrl) })
  const walletClient = createWalletClient({ account: deployer, chain, transport: http(rpcUrl) })

  const result = await deploySafeAndRoles({
    publicClient,
    walletClient,
    botAddress,
    poolAddress,
    roleKey,
    addresses,
    saltNonce,
  })

  console.log('\nDone. Set these in the bot .env:')
  console.log(`  SAFE_ADDRESS=${result.safeAddress}`)
  console.log(`  ROLES_MODIFIER_ADDRESS=${result.rolesModifierAddress}`)
  console.log(`  ROLE_KEY=${result.roleKey}`)
}

main().catch((err) => {
  console.error(err)
  process.exit(1)
})
