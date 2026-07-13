import 'dotenv/config'

import {
  DELEVERAGER_ROLE_KEY,
  MAINTENANCE_ROLE_KEY,
  rolesV2Abi,
  ROLLER_ROLE_KEY,
  SIZE_ADJUSTER_ROLE_KEY,
} from '@panoptic-eng/sdk/zodiac'
import { createPublicClient, createWalletClient, encodeFunctionData, getAddress, http } from 'viem'
import { privateKeyToAccount } from 'viem/accounts'

import { defineBotChain } from '../src/utils/chain'
import { execFromSoleOwner } from './lib/safeExec'

/**
 * Add or remove a member of a Zodiac Roles role on an already-deployed Safe.
 *
 * After `pnpm onboard`, the Roles modifier is owned by the Safe, so role
 * membership can only be changed by the Safe. This routes `assignRoles` through
 * the Safe via the sole owner (pre-validated signature) — the same trust model
 * as deployment. Scopes/conditions are unchanged; this only (un)assigns a member.
 *
 * Required env:
 *   RPC_URL, CHAIN_ID, SAFE_ADDRESS, ROLES_MODIFIER_ADDRESS,
 *   ROLES_OWNER_PRIVATE_KEY (a Safe owner), ROLE, MEMBER
 * Optional:
 *   ENABLED (default 'true'; 'false' revokes)
 *
 * ROLE is either a bytes32 role key (e.g. the bot's ROLE_KEY from .env) or a
 * canonical name: deleverager | maintenance | roller | size-adjuster.
 */

const NAMED_ROLES: Record<string, `0x${string}`> = {
  deleverager: DELEVERAGER_ROLE_KEY,
  maintenance: MAINTENANCE_ROLE_KEY,
  roller: ROLLER_ROLE_KEY,
  'size-adjuster': SIZE_ADJUSTER_ROLE_KEY,
}

function requireEnv(name: string): string {
  const v = process.env[name]
  if (!v) throw new Error(`missing env ${name}`)
  return v
}

function resolveRoleKey(input: string): `0x${string}` {
  if (/^0x[a-fA-F0-9]{64}$/.test(input)) return input as `0x${string}`
  const named = NAMED_ROLES[input]
  if (named) return named
  throw new Error(
    `ROLE must be a bytes32 key or one of: ${Object.keys(NAMED_ROLES).join(', ')} (got "${input}")`,
  )
}

async function main(): Promise<void> {
  const chainId = Number(requireEnv('CHAIN_ID'))
  const rpcUrl = requireEnv('RPC_URL')
  const safeAddress = getAddress(requireEnv('SAFE_ADDRESS'))
  const rolesModifier = getAddress(requireEnv('ROLES_MODIFIER_ADDRESS'))
  const owner = privateKeyToAccount(requireEnv('ROLES_OWNER_PRIVATE_KEY') as `0x${string}`)
  const roleKey = resolveRoleKey(requireEnv('ROLE'))
  const member = getAddress(requireEnv('MEMBER'))
  const enabled = (process.env.ENABLED ?? 'true') !== 'false'

  const chain = defineBotChain(chainId, rpcUrl)
  const publicClient = createPublicClient({ chain, transport: http(rpcUrl) })
  const walletClient = createWalletClient({ account: owner, chain, transport: http(rpcUrl) })

  const data = encodeFunctionData({
    abi: rolesV2Abi,
    functionName: 'assignRoles',
    args: [member, [roleKey], [enabled]],
  })

  console.log(
    `${enabled ? 'assigning' : 'revoking'} role ${roleKey}\n  member ${member}\n  via Safe ${safeAddress} → modifier ${rolesModifier}`,
  )
  const hash = await execFromSoleOwner({
    publicClient,
    walletClient,
    safeAddress,
    to: rolesModifier,
    data,
  })
  console.log(`done (tx ${hash})`)
}

main().catch((err) => {
  console.error(err instanceof Error ? err.message : err)
  process.exit(1)
})
