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
import { type ExtraRoleKind, buildExtraRoleSteps } from './lib/deployCore'
import { emitSafeTransactionBuilderBatch } from './lib/safeProposal'

const NAMED_ROLES: Record<string, `0x${string}`> = {
  deleverager: DELEVERAGER_ROLE_KEY,
  maintenance: MAINTENANCE_ROLE_KEY,
  roller: ROLLER_ROLE_KEY,
  'size-adjuster': SIZE_ADJUSTER_ROLE_KEY,
}

// Only the reviewed production roles may be scoped through the provision path.
// The high-privilege experimental roles (maintenance/roller/size-adjuster) are
// intentionally NOT provisionable here — they would break the exact production
// manifest and must be scoped out-of-band if a separate keeper needs them.
const PROVISIONABLE_ROLE_KINDS: readonly ExtraRoleKind[] = ['deleverager']

function asExtraRoleKind(input: string): ExtraRoleKind {
  if ((PROVISIONABLE_ROLE_KINDS as readonly string[]).includes(input)) return input as ExtraRoleKind
  throw new Error(
    `ROLE must be one of ${PROVISIONABLE_ROLE_KINDS.join(', ')} to provision (got ${input}); ` +
      'assign/revoke also accept a raw bytes32 key',
  )
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

/**
 * ACTION selects what batch to emit for the Safe owner to execute:
 *   - assign  (default): add MEMBER to ROLE (assignRoles member=true)
 *   - revoke:            remove MEMBER from ROLE (assignRoles member=false)
 *   - provision:         full role scoping (assignRoles + scopeTarget +
 *                        scopeFunction) for a named à-la-carte role on POOL_ADDRESS.
 *                        This is the existing-deployment path for the deleverager.
 */
function main(): void {
  const chainId = Number(requireEnv('CHAIN_ID'))
  const safeAddress = getAddress(requireEnv('SAFE_ADDRESS'))
  const rolesModifier = getAddress(requireEnv('ROLES_MODIFIER_ADDRESS'))
  const member = getAddress(requireEnv('MEMBER'))
  const action = (process.env.ACTION ?? 'assign').toLowerCase()

  if (action === 'provision') {
    const kind = asExtraRoleKind(requireEnv('ROLE'))
    const pool = getAddress(requireEnv('POOL_ADDRESS'))
    const sizeCap = process.env.SIZE_CAP ? BigInt(process.env.SIZE_CAP) : undefined
    // Honor a custom deleverager role key so provisioning scopes the same key
    // the bot's doctor/manifest checks verify (config `DELEVERAGER_ROLE_KEY`).
    const roleKeyOverride = process.env.DELEVERAGER_ROLE_KEY
    if (roleKeyOverride && !/^0x[a-fA-F0-9]{64}$/.test(roleKeyOverride)) {
      throw new Error('DELEVERAGER_ROLE_KEY must be a bytes32 hex string')
    }
    const steps = buildExtraRoleSteps(
      { kind, member, sizeCap, roleKey: roleKeyOverride as `0x${string}` | undefined },
      pool,
      safeAddress,
    )
    emitSafeTransactionBuilderBatch({
      chainId,
      safeAddress,
      name: `Provision ${kind} role`,
      description: `Scope the ${kind} role for ${member} on pool ${pool}`,
      calls: steps.map((step) => ({
        description: `${step.name} on the Roles modifier`,
        to: rolesModifier,
        value: 0n,
        data: encodeFunctionData({
          abi: rolesV2Abi,
          functionName: step.functionName,
          args: step.args as never,
        }),
      })),
    })
    return
  }

  if (action !== 'assign' && action !== 'revoke') {
    throw new Error('ACTION must be one of: assign, revoke, provision')
  }
  const enabled = action === 'assign'
  const roleKey = resolveRoleKey(requireEnv('ROLE'))
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
