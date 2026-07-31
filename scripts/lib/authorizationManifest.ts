import {
  type ScopeStep,
  buildDeleveragerDispatchConditions,
  buildLoanOnlyDispatchConditions,
  buildSfpmSwapVenueSteps,
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

export interface AuthorizationManifestDiff {
  missing: string[]
  unexpected: string[]
  changed: string[]
}

function describeEntry(
  field: keyof ReturnType<typeof comparable>,
  key: string,
  value?: unknown,
): string {
  const parts = key.split(':')
  switch (field) {
    case 'members':
      return `member ${parts[1]} assigned to role ${parts[0]}`
    case 'targets':
      return `target ${parts[1]} under role ${parts[0]}`
    case 'functions':
      return `function ${parts[2]} on ${parts[1]} under role ${parts[0]}`
    case 'enabledModules':
      return `enabled module ${key}`
    case 'defaultRoles':
      return `default role for module ${key}`
    case 'unwrappers':
      return `transaction unwrapper for ${parts[0]} selector ${parts[1]}`
    case 'allowances':
      return `Roles allowance ${key}`
    default:
      return `${field} ${key}${value === undefined ? '' : ` (${JSON.stringify(value)})`}`
  }
}

function diffComparable(
  actual: ReturnType<typeof comparable>,
  expected: ReturnType<typeof comparable>,
): AuthorizationManifestDiff {
  const diff: AuthorizationManifestDiff = { missing: [], unexpected: [], changed: [] }
  for (const field of Object.keys(expected) as (keyof typeof expected)[]) {
    const actualEntries = actual[field]
    const expectedEntries = expected[field]
    const actualMap = new Map(
      actualEntries.map((entry) =>
        Array.isArray(entry) ? [String(entry[0]), entry[1]] : [String(entry), true],
      ),
    )
    const expectedMap = new Map(
      expectedEntries.map((entry) =>
        Array.isArray(entry) ? [String(entry[0]), entry[1]] : [String(entry), true],
      ),
    )
    for (const [key, expectedValue] of expectedMap) {
      if (!actualMap.has(key)) {
        diff.missing.push(describeEntry(field, key, expectedValue))
      } else if (JSON.stringify(actualMap.get(key)) !== JSON.stringify(expectedValue)) {
        diff.changed.push(describeEntry(field, key, actualMap.get(key)))
      }
    }
    for (const [key, actualValue] of actualMap) {
      if (!expectedMap.has(key)) {
        diff.unexpected.push(describeEntry(field, key, actualValue))
      }
    }
  }
  return diff
}

export function formatAuthorizationManifestDiff(
  diff: AuthorizationManifestDiff,
  limit = 6,
): string {
  const entries = [
    ...diff.unexpected.map((entry) => `unexpected ${entry}`),
    ...diff.changed.map((entry) => `changed ${entry}`),
    ...diff.missing.map((entry) => `missing ${entry}`),
  ]
  const visible = entries.slice(0, limit)
  const remainder = entries.length - visible.length
  return `${visible.join('; ')}${remainder > 0 ? `; plus ${remainder} more` : ''}`
}

function expectedManifest(
  botAddress: Address,
  roleKey: Hex,
  poolAddress: Address,
  deleverager?: { member: Address; roleKey: Hex },
  sfpmSwap?: SfpmSwapAuthorization,
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
  if (sfpmSwap) {
    const sfpmExpected = expectedSfpmSwapManifest(sfpmSwap)
    for (const [key, value] of sfpmExpected.targets) expected.targets.set(key, value)
    for (const [key, value] of sfpmExpected.functions) expected.functions.set(key, value)
    for (const [key, value] of sfpmExpected.unwrappers) expected.unwrappers.set(key, value)
  }
  return expected
}

function scopeStepHex(step: ScopeStep, index: number): Hex {
  const value = step.args[index]
  if (typeof value !== 'string' || !value.startsWith('0x')) {
    throw new Error(`invalid ${step.functionName} argument ${index}`)
  }
  return value as Hex
}

function scopeStepNumber(step: ScopeStep, index: number): number {
  const value = step.args[index]
  if (typeof value !== 'number') {
    throw new Error(`invalid ${step.functionName} argument ${index}`)
  }
  return value
}

function scopeStepConditions(
  step: ScopeStep,
  index: number,
): readonly { parent: number; paramType: number; operator: number; compValue: Hex }[] {
  const value = step.args[index]
  if (!Array.isArray(value)) {
    throw new Error(`invalid ${step.functionName} conditions`)
  }
  return value.map((condition) => {
    if (!condition || typeof condition !== 'object') {
      throw new Error(`invalid ${step.functionName} condition`)
    }
    const record = condition as Record<string, unknown>
    if (
      typeof record.parent !== 'number' ||
      typeof record.paramType !== 'number' ||
      typeof record.operator !== 'number' ||
      typeof record.compValue !== 'string' ||
      !record.compValue.startsWith('0x')
    ) {
      throw new Error(`invalid ${step.functionName} condition fields`)
    }
    return {
      parent: record.parent,
      paramType: record.paramType,
      operator: record.operator,
      compValue: record.compValue as Hex,
    }
  })
}

export interface SfpmSwapAuthorization {
  roleKey: Hex
  safe: Address
  sfpm: Address
  collateralTracker0: Address
  collateralTracker1: Address
  adapter: Address
  poolIdPin: bigint
  multiSendCallOnly: Address
  multiSendUnwrapper: Address
  nativeCollateral?: 'token0' | 'token1' | 'none'
  weth9?: Address
}

function expectedSfpmSwapManifest(params: SfpmSwapAuthorization): ManifestState {
  const expected = emptyState()
  const steps = buildSfpmSwapVenueSteps(params)
  for (const step of steps) {
    switch (step.functionName) {
      case 'scopeTarget': {
        const roleKey = scopeStepHex(step, 0)
        const target = scopeStepHex(step, 1)
        expected.targets.set(roleTarget(roleKey, target), {
          clearance: 'function',
          options: 0,
        })
        break
      }
      case 'scopeFunction': {
        const roleKey = scopeStepHex(step, 0)
        const target = scopeStepHex(step, 1)
        const selector = scopeStepHex(step, 2)
        expected.functions.set(roleFunction(roleKey, target, selector), {
          options: scopeStepNumber(step, 4),
          conditions: normalizeConditions(scopeStepConditions(step, 3)),
        })
        break
      }
      case 'allowFunction': {
        const roleKey = scopeStepHex(step, 0)
        const target = scopeStepHex(step, 1)
        const selector = scopeStepHex(step, 2)
        expected.functions.set(roleFunction(roleKey, target, selector), {
          options: scopeStepNumber(step, 3),
          conditions: 'wildcard',
        })
        break
      }
      case 'setTransactionUnwrapper': {
        const target = scopeStepHex(step, 0)
        const selector = scopeStepHex(step, 1)
        expected.unwrappers.set(
          `${address(target)}:${selector.toLowerCase()}`,
          address(scopeStepHex(step, 2)),
        )
        break
      }
      case 'assignRoles':
        throw new Error('SFPM venue steps must not assign roles')
    }
  }
  return expected
}

function assertExpectedSubset(
  actual: ManifestState,
  expected: ManifestState,
  field: 'targets' | 'functions' | 'unwrappers',
): void {
  for (const [key, expectedValue] of expected[field]) {
    const actualValue = actual[field].get(key)
    if (JSON.stringify(actualValue) !== JSON.stringify(expectedValue)) {
      throw new Error(`SFPM venue authorization is missing or stale: ${field}.${key}`)
    }
  }
}

/**
 * Verify the complete SFPM-specific authorization subset without requiring the
 * modifier to be dedicated to one pool. This supports existing Safes whose
 * Roles modifier legitimately contains other additive pool/keeper scopes.
 */
export async function verifySfpmSwapAuthorization(
  params: {
    publicClient: PublicClient
    rolesModifierAddress: Address
    deploymentBlock: bigint
  } & SfpmSwapAuthorization,
): Promise<void> {
  const actual = await reconstructManifest(
    params.publicClient,
    params.rolesModifierAddress,
    params.deploymentBlock,
  )
  const expected = expectedSfpmSwapManifest(params)
  assertExpectedSubset(actual, expected, 'targets')
  assertExpectedSubset(actual, expected, 'functions')
  assertExpectedSubset(actual, expected, 'unwrappers')
}

export interface ExactAuthorizationManifestParams {
  publicClient: PublicClient
  rolesModifierAddress: Address
  botAddress: Address
  roleKey: Hex
  poolAddress: Address
  deploymentBlock: bigint
  // When set, the reviewed manifest additionally admits the burn-only
  // deleverager role for this member (and nothing else).
  deleverager?: { member: Address; roleKey: Hex }
  // When enabled, the exact reviewed graph additionally admits the canonical
  // SFPM venue subset (and no unrelated targets/functions).
  sfpmSwap?: SfpmSwapAuthorization
}

/** Return the exact event-derived difference from the reviewed permission graph. */
export async function inspectExactAuthorizationManifest(
  params: ExactAuthorizationManifestParams,
): Promise<AuthorizationManifestDiff> {
  const actual = comparable(
    await reconstructManifest(
      params.publicClient,
      params.rolesModifierAddress,
      params.deploymentBlock,
    ),
  )
  const expected = comparable(
    expectedManifest(
      params.botAddress,
      params.roleKey,
      params.poolAddress,
      params.deleverager,
      params.sfpmSwap,
    ),
  )
  return diffComparable(actual, expected)
}

/** Compare the complete final Roles event-derived graph to the reviewed in-pool manifest. */
export async function verifyExactAuthorizationManifest(
  params: ExactAuthorizationManifestParams,
): Promise<void> {
  const diff = await inspectExactAuthorizationManifest(params)
  if (diff.missing.length > 0 || diff.unexpected.length > 0 || diff.changed.length > 0) {
    throw new Error(
      `deployed Roles permission graph does not exactly match the reviewed single-member, ` +
        `single-pool manifest (loan-only${params.deleverager ? ' + burn-only deleverager' : ''}` +
        `${params.sfpmSwap ? ' + SFPM venue' : ''}); ` +
        formatAuthorizationManifestDiff(diff),
    )
  }
}
