import {
  buildDeleveragerDispatchConditions,
  buildLoanOnlyDispatchConditions,
} from '@panoptic-eng/sdk/zodiac'
import type { Address, Hex, PublicClient } from 'viem'
import { decodeEventLog, getAddress, zeroAddress } from 'viem'

import { DISPATCH_SELECTOR } from './deployCore'

const rolesAuditEvents = [
  {
    type: 'event',
    name: 'AssignRoles',
    inputs: [
      { name: 'module', type: 'address', indexed: false },
      { name: 'roleKeys', type: 'bytes32[]', indexed: false },
      { name: 'memberOf', type: 'bool[]', indexed: false },
    ],
  },
  {
    type: 'event',
    name: 'AllowTarget',
    inputs: [
      { name: 'roleKey', type: 'bytes32', indexed: false },
      { name: 'targetAddress', type: 'address', indexed: false },
      { name: 'options', type: 'uint8', indexed: false },
    ],
  },
  {
    type: 'event',
    name: 'RevokeTarget',
    inputs: [
      { name: 'roleKey', type: 'bytes32', indexed: false },
      { name: 'targetAddress', type: 'address', indexed: false },
    ],
  },
  {
    type: 'event',
    name: 'ScopeTarget',
    inputs: [
      { name: 'roleKey', type: 'bytes32', indexed: false },
      { name: 'targetAddress', type: 'address', indexed: false },
    ],
  },
  {
    type: 'event',
    name: 'AllowFunction',
    inputs: [
      { name: 'roleKey', type: 'bytes32', indexed: false },
      { name: 'targetAddress', type: 'address', indexed: false },
      { name: 'selector', type: 'bytes4', indexed: false },
      { name: 'options', type: 'uint8', indexed: false },
    ],
  },
  {
    type: 'event',
    name: 'RevokeFunction',
    inputs: [
      { name: 'roleKey', type: 'bytes32', indexed: false },
      { name: 'targetAddress', type: 'address', indexed: false },
      { name: 'selector', type: 'bytes4', indexed: false },
    ],
  },
  {
    type: 'event',
    name: 'ScopeFunction',
    inputs: [
      { name: 'roleKey', type: 'bytes32', indexed: false },
      { name: 'targetAddress', type: 'address', indexed: false },
      { name: 'selector', type: 'bytes4', indexed: false },
      {
        name: 'conditions',
        type: 'tuple[]',
        indexed: false,
        components: [
          { name: 'parent', type: 'uint8' },
          { name: 'paramType', type: 'uint8' },
          { name: 'operator', type: 'uint8' },
          { name: 'compValue', type: 'bytes' },
        ],
      },
      { name: 'options', type: 'uint8', indexed: false },
    ],
  },
  {
    type: 'event',
    name: 'SetUnwrapAdapter',
    inputs: [
      { name: 'to', type: 'address', indexed: false },
      { name: 'selector', type: 'bytes4', indexed: false },
      { name: 'adapter', type: 'address', indexed: false },
    ],
  },
  {
    type: 'event',
    name: 'SetDefaultRole',
    inputs: [
      { name: 'module', type: 'address', indexed: false },
      { name: 'defaultRoleKey', type: 'bytes32', indexed: false },
    ],
  },
  {
    type: 'event',
    name: 'SetAllowance',
    inputs: [
      { name: 'allowanceKey', type: 'bytes32', indexed: false },
      { name: 'balance', type: 'uint128', indexed: false },
      { name: 'maxRefill', type: 'uint128', indexed: false },
      { name: 'refill', type: 'uint128', indexed: false },
      { name: 'period', type: 'uint64', indexed: false },
      { name: 'timestamp', type: 'uint64', indexed: false },
    ],
  },
  {
    type: 'event',
    name: 'EnabledModule',
    // Zodiac's `EnabledModule(address module)` is NOT indexed — the module is in
    // the log data. Declaring it indexed makes strict decodeEventLog reject the
    // real event, silently dropping every enabled module from the reconstructed
    // manifest (verification would then never see the bot as an enabled module).
    inputs: [{ name: 'module', type: 'address', indexed: false }],
  },
  {
    type: 'event',
    name: 'DisabledModule',
    inputs: [{ name: 'module', type: 'address', indexed: false }],
  },
] as const

interface ManifestState {
  members: Map<string, boolean>
  targets: Map<string, { clearance: 'target' | 'function'; options: number }>
  functions: Map<
    string,
    {
      options: number
      conditions:
        | readonly { parent: number; paramType: number; operator: number; compValue: Hex }[]
        | 'wildcard'
    }
  >
  enabledModules: Set<string>
  defaultRoles: Map<string, Hex>
  unwrappers: Map<string, string>
  allowances: Set<string>
}

function address(address: Address): string {
  return getAddress(address).toLowerCase()
}

function roleTarget(roleKey: Hex, target: Address): string {
  return `${roleKey.toLowerCase()}:${address(target)}`
}

function roleFunction(roleKey: Hex, target: Address, selector: Hex): string {
  return `${roleTarget(roleKey, target)}:${selector.toLowerCase()}`
}

function emptyState(): ManifestState {
  return {
    members: new Map(),
    targets: new Map(),
    functions: new Map(),
    enabledModules: new Set(),
    defaultRoles: new Map(),
    unwrappers: new Map(),
    allowances: new Set(),
  }
}

function normalizeConditions(
  conditions: readonly { parent: number; paramType: number; operator: number; compValue: Hex }[],
) {
  return conditions.map((condition) => ({
    parent: condition.parent,
    paramType: condition.paramType,
    operator: condition.operator,
    compValue: condition.compValue.toLowerCase() as Hex,
  }))
}

async function reconstructManifest(
  publicClient: PublicClient,
  rolesModifierAddress: Address,
  deploymentBlock: bigint,
): Promise<ManifestState> {
  const state = emptyState()
  const logs = await publicClient.getLogs({
    address: rolesModifierAddress,
    fromBlock: deploymentBlock,
    toBlock: 'latest',
  })
  for (const log of logs) {
    let decoded
    try {
      decoded = decodeEventLog({
        abi: rolesAuditEvents,
        data: log.data,
        topics: log.topics,
        strict: true,
      })
    } catch {
      continue
    }
    const { eventName, args } = decoded
    switch (eventName) {
      case 'AssignRoles':
        args.roleKeys.forEach((roleKey, index) => {
          const key = `${roleKey.toLowerCase()}:${address(args.module)}`
          if (args.memberOf[index]) state.members.set(key, true)
          else state.members.delete(key)
        })
        break
      case 'AllowTarget':
        state.targets.set(roleTarget(args.roleKey, args.targetAddress), {
          clearance: 'target',
          options: args.options,
        })
        break
      case 'ScopeTarget':
        state.targets.set(roleTarget(args.roleKey, args.targetAddress), {
          clearance: 'function',
          options: 0,
        })
        break
      case 'RevokeTarget':
        state.targets.delete(roleTarget(args.roleKey, args.targetAddress))
        break
      case 'AllowFunction':
        state.functions.set(roleFunction(args.roleKey, args.targetAddress, args.selector), {
          options: args.options,
          conditions: 'wildcard',
        })
        break
      case 'ScopeFunction':
        state.functions.set(roleFunction(args.roleKey, args.targetAddress, args.selector), {
          options: args.options,
          conditions: normalizeConditions(args.conditions),
        })
        break
      case 'RevokeFunction':
        state.functions.delete(roleFunction(args.roleKey, args.targetAddress, args.selector))
        break
      case 'EnabledModule':
        state.enabledModules.add(address(args.module))
        break
      case 'DisabledModule':
        state.enabledModules.delete(address(args.module))
        break
      case 'SetDefaultRole':
        if (BigInt(args.defaultRoleKey) === 0n) state.defaultRoles.delete(address(args.module))
        else state.defaultRoles.set(address(args.module), args.defaultRoleKey.toLowerCase() as Hex)
        break
      case 'SetUnwrapAdapter': {
        const key = `${address(args.to)}:${args.selector.toLowerCase()}`
        if (address(args.adapter) === address(zeroAddress)) state.unwrappers.delete(key)
        else state.unwrappers.set(key, address(args.adapter))
        break
      }
      case 'SetAllowance':
        if (
          args.balance === 0n &&
          args.maxRefill === 0n &&
          args.refill === 0n &&
          args.period === 0n &&
          args.timestamp === 0n
        ) {
          state.allowances.delete(args.allowanceKey.toLowerCase())
        } else {
          state.allowances.add(args.allowanceKey.toLowerCase())
        }
        break
    }
  }
  return state
}

function comparable(state: ManifestState) {
  const sorted = <T>(entries: Iterable<T>) =>
    [...entries].sort((left, right) => JSON.stringify(left).localeCompare(JSON.stringify(right)))
  return {
    members: sorted(state.members.entries()),
    targets: sorted(state.targets.entries()),
    functions: sorted(state.functions.entries()),
    enabledModules: sorted(state.enabledModules),
    defaultRoles: sorted(state.defaultRoles.entries()),
    unwrappers: sorted(state.unwrappers.entries()),
    allowances: sorted(state.allowances),
  }
}

function expectedManifest(
  botAddress: Address,
  roleKey: Hex,
  poolAddress: Address,
  deleverager?: { member: Address; roleKey: Hex },
): ManifestState {
  const expected = emptyState()
  expected.members.set(`${roleKey.toLowerCase()}:${address(botAddress)}`, true)
  expected.enabledModules.add(address(botAddress))
  expected.targets.set(roleTarget(roleKey, poolAddress), { clearance: 'function', options: 0 })
  expected.functions.set(roleFunction(roleKey, poolAddress, DISPATCH_SELECTOR), {
    options: 0,
    conditions: normalizeConditions(buildLoanOnlyDispatchConditions()),
  })
  if (deleverager) {
    expected.members.set(
      `${deleverager.roleKey.toLowerCase()}:${address(deleverager.member)}`,
      true,
    )
    expected.enabledModules.add(address(deleverager.member))
    expected.targets.set(roleTarget(deleverager.roleKey, poolAddress), {
      clearance: 'function',
      options: 0,
    })
    expected.functions.set(roleFunction(deleverager.roleKey, poolAddress, DISPATCH_SELECTOR), {
      options: 0,
      conditions: normalizeConditions(buildDeleveragerDispatchConditions()),
    })
  }
  return expected
}

/** Compare the complete final Roles event-derived graph to the reviewed in-pool manifest. */
export async function verifyExactAuthorizationManifest(params: {
  publicClient: PublicClient
  rolesModifierAddress: Address
  botAddress: Address
  roleKey: Hex
  poolAddress: Address
  deploymentBlock: bigint
  // When set, the reviewed manifest additionally admits the burn-only
  // deleverager role for this member (and nothing else).
  deleverager?: { member: Address; roleKey: Hex }
}): Promise<void> {
  const actual = comparable(
    await reconstructManifest(
      params.publicClient,
      params.rolesModifierAddress,
      params.deploymentBlock,
    ),
  )
  const expected = comparable(
    expectedManifest(params.botAddress, params.roleKey, params.poolAddress, params.deleverager),
  )
  if (JSON.stringify(actual) !== JSON.stringify(expected)) {
    throw new Error(
      `deployed Roles permission graph does not exactly match the reviewed single-member, ` +
        `single-pool manifest (loan-only${params.deleverager ? ' + burn-only deleverager' : ''}); ` +
        `re-onboard with a fresh role/modifier`,
    )
  }
}
