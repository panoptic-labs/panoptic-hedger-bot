import 'dotenv/config'

import {
  DELEVERAGER_ROLE_KEY,
  MAINTENANCE_ROLE_KEY,
  rolesV2Abi,
  ROLLER_ROLE_KEY,
  SIZE_ADJUSTER_ROLE_KEY,
} from '@panoptic-eng/sdk/zodiac'
import { encodeFunctionData, getAddress } from 'viem'

import { sanitizeError } from '../src/utils/sanitize'
import { emitSafeTransactionBuilderBatch } from './lib/safeProposal'

const NAMED_ROLES: Record<string, `0x${string}`> = {
  deleverager: DELEVERAGER_ROLE_KEY,
  maintenance: MAINTENANCE_ROLE_KEY,
  roller: ROLLER_ROLE_KEY,
  'size-adjuster': SIZE_ADJUSTER_ROLE_KEY,
}

function requireEnv(name: string): string {
  const value = process.env[name]
  if (!value) throw new Error(`missing env ${name}`)
  return value
}

function resolveRoleKey(input: string): `0x${string}` {
  if (/^0x[a-fA-F0-9]{64}$/.test(input)) return input as `0x${string}`
  const named = NAMED_ROLES[input]
  if (named) return named
  throw new Error(`ROLE must be bytes32 or one of: ${Object.keys(NAMED_ROLES).join(', ')}`)
}

function main(): void {
  const chainId = Number(requireEnv('CHAIN_ID'))
  const safeAddress = getAddress(requireEnv('SAFE_ADDRESS'))
  const rolesModifier = getAddress(requireEnv('ROLES_MODIFIER_ADDRESS'))
  const roleKey = resolveRoleKey(requireEnv('ROLE'))
  const member = getAddress(requireEnv('MEMBER'))
  const normalizedEnabled = (process.env.ENABLED ?? 'true').toLowerCase()
  if (normalizedEnabled !== 'true' && normalizedEnabled !== 'false') {
    throw new Error('ENABLED must be true or false (case-insensitive)')
  }
  const enabled = normalizedEnabled === 'true'
  const data = encodeFunctionData({
    abi: rolesV2Abi,
    functionName: 'assignRoles',
    args: [member, [roleKey], [enabled]],
  })

  emitSafeTransactionBuilderBatch({
    chainId,
    safeAddress,
    name: `${enabled ? 'Assign' : 'Revoke'} Zodiac role`,
    description: `${enabled ? 'Assign' : 'Revoke'} ${roleKey} for ${member}`,
    calls: [
      {
        description: `${enabled ? 'assign' : 'revoke'} member ${member} for role ${roleKey}`,
        to: rolesModifier,
        value: 0n,
        data,
      },
    ],
  })
}

try {
  main()
} catch (error) {
  console.error(sanitizeError(error))
  process.exitCode = 1
}
