import {
  type ConditionFlat,
  type ScopeStep,
  buildDeleveragerDispatchConditions,
  buildLoanOnlyDispatchConditions,
  buildSfpmSwapVenueSteps,
  DELEVERAGER_ROLE_KEY,
} from '@panoptic-eng/sdk/zodiac'
import type { Address, Hex, PublicClient } from 'viem'
import { encodeAbiParameters, encodeEventTopics, parseAbiItem } from 'viem'
import { describe, expect, it, vi } from 'vitest'

import {
  formatAuthorizationManifestDiff,
  inspectExactAuthorizationManifest,
  verifyExactAuthorizationManifest,
  verifySfpmSwapAuthorization,
} from './authorizationManifest'

const MODIFIER: Address = '0x1111111111111111111111111111111111111111'
const BOT: Address = '0x2222222222222222222222222222222222222222'
const EXTRA: Address = '0x3333333333333333333333333333333333333333'
const POOL: Address = '0x4444444444444444444444444444444444444444'
const ROLE = `0x${'55'.repeat(32)}` as Hex
const DISPATCH = '0xc25813aa' as const
const SAFE: Address = '0x7777777777777777777777777777777777777777'
const SFPM: Address = '0x8888888888888888888888888888888888888888'
const CT0: Address = '0x9999999999999999999999999999999999999999'
const CT1: Address = '0xaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaa'
const ADAPTER: Address = '0xbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbb'
const MULTISEND: Address = '0xcccccccccccccccccccccccccccccccccccccccc'
const UNWRAPPER: Address = '0xdddddddddddddddddddddddddddddddddddddddd'
const WETH: Address = '0xeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeee'

const assignEvent = parseAbiItem(
  'event AssignRoles(address module, bytes32[] roleKeys, bool[] memberOf)',
)
const enabledEvent = parseAbiItem('event EnabledModule(address module)')
const scopeTargetEvent = parseAbiItem('event ScopeTarget(bytes32 roleKey, address targetAddress)')
const scopeFunctionEvent = {
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
} as const
const allowFunctionEvent = parseAbiItem(
  'event AllowFunction(bytes32 roleKey, address targetAddress, bytes4 selector, uint8 options)',
)
const setUnwrapAdapterEvent = parseAbiItem(
  'event SetUnwrapAdapter(address to, bytes4 selector, address adapter)',
)

function log(topics: readonly (Hex | Hex[] | null)[], data: Hex) {
  // encodeEventTopics returns `[Hex, ...(Hex | Hex[] | null)[]]`; these events
  // have only scalar, always-present topics, so keep the plain Hex entries.
  return { address: MODIFIER, topics: topics.filter((t): t is Hex => typeof t === 'string'), data }
}

function assign(module: Address, role = ROLE) {
  return log(
    encodeEventTopics({ abi: [assignEvent], eventName: 'AssignRoles' }),
    encodeAbiParameters(
      [{ type: 'address' }, { type: 'bytes32[]' }, { type: 'bool[]' }],
      [module, [role], [true]],
    ),
  )
}

function enabled(module: Address) {
  // module is non-indexed → it lives in the log data, not the topics (mirrors
  // the real Zodiac EnabledModule event; see authorizationManifest.ts).
  return log(
    encodeEventTopics({ abi: [enabledEvent], eventName: 'EnabledModule' }),
    encodeAbiParameters([{ type: 'address' }], [module]),
  )
}

function scopeTarget(target = POOL) {
  return log(
    encodeEventTopics({ abi: [scopeTargetEvent], eventName: 'ScopeTarget' }),
    encodeAbiParameters([{ type: 'bytes32' }, { type: 'address' }], [ROLE, target]),
  )
}

function scopeFunction() {
  return log(
    encodeEventTopics({ abi: [scopeFunctionEvent], eventName: 'ScopeFunction' }),
    encodeAbiParameters(
      [
        { type: 'bytes32' },
        { type: 'address' },
        { type: 'bytes4' },
        {
          type: 'tuple[]',
          components: [
            { name: 'parent', type: 'uint8' },
            { name: 'paramType', type: 'uint8' },
            { name: 'operator', type: 'uint8' },
            { name: 'compValue', type: 'bytes' },
          ],
        },
        { type: 'uint8' },
      ],
      [ROLE, POOL, DISPATCH, buildLoanOnlyDispatchConditions(), 0],
    ),
  )
}

function scopeTargetFor(role: Hex, target = POOL) {
  return log(
    encodeEventTopics({ abi: [scopeTargetEvent], eventName: 'ScopeTarget' }),
    encodeAbiParameters([{ type: 'bytes32' }, { type: 'address' }], [role, target]),
  )
}

function scopeFunctionFor(
  role: Hex,
  target: Address,
  selector: Hex,
  conditions: readonly ConditionFlat[],
  options: number,
) {
  return log(
    encodeEventTopics({ abi: [scopeFunctionEvent], eventName: 'ScopeFunction' }),
    encodeAbiParameters(
      [
        { type: 'bytes32' },
        { type: 'address' },
        { type: 'bytes4' },
        {
          type: 'tuple[]',
          components: [
            { name: 'parent', type: 'uint8' },
            { name: 'paramType', type: 'uint8' },
            { name: 'operator', type: 'uint8' },
            { name: 'compValue', type: 'bytes' },
          ],
        },
        { type: 'uint8' },
      ],
      [role, target, selector.slice(0, 10) as Hex, conditions, options],
    ),
  )
}

function allowFunctionFor(role: Hex, target: Address, selector: Hex, options: number) {
  return log(
    encodeEventTopics({ abi: [allowFunctionEvent], eventName: 'AllowFunction' }),
    encodeAbiParameters(
      [{ type: 'bytes32' }, { type: 'address' }, { type: 'bytes4' }, { type: 'uint8' }],
      [role, target, selector.slice(0, 10) as Hex, options],
    ),
  )
}

function setUnwrapperFor(target: Address, selector: Hex, adapter: Address) {
  return log(
    encodeEventTopics({ abi: [setUnwrapAdapterEvent], eventName: 'SetUnwrapAdapter' }),
    encodeAbiParameters(
      [{ type: 'address' }, { type: 'bytes4' }, { type: 'address' }],
      [target, selector.slice(0, 10) as Hex, adapter],
    ),
  )
}

function sfpmStepLog(step: ScopeStep) {
  switch (step.functionName) {
    case 'scopeTarget': {
      const [role, target] = step.args as [Hex, Address]
      return scopeTargetFor(role, target)
    }
    case 'scopeFunction': {
      const [role, target, selector, conditions, options] = step.args as [
        Hex,
        Address,
        Hex,
        ConditionFlat[],
        number,
      ]
      return scopeFunctionFor(role, target, selector, conditions, options)
    }
    case 'allowFunction': {
      const [role, target, selector, options] = step.args as [Hex, Address, Hex, number]
      return allowFunctionFor(role, target, selector, options)
    }
    case 'setTransactionUnwrapper': {
      const [target, selector, adapter] = step.args as [Address, Hex, Address]
      return setUnwrapperFor(target, selector, adapter)
    }
    case 'assignRoles':
      throw new Error('unexpected role assignment in SFPM steps')
  }
}

function deleveragerScopeFunction() {
  return log(
    encodeEventTopics({ abi: [scopeFunctionEvent], eventName: 'ScopeFunction' }),
    encodeAbiParameters(
      [
        { type: 'bytes32' },
        { type: 'address' },
        { type: 'bytes4' },
        {
          type: 'tuple[]',
          components: [
            { name: 'parent', type: 'uint8' },
            { name: 'paramType', type: 'uint8' },
            { name: 'operator', type: 'uint8' },
            { name: 'compValue', type: 'bytes' },
          ],
        },
        { type: 'uint8' },
      ],
      [DELEVERAGER_ROLE_KEY, POOL, DISPATCH, buildDeleveragerDispatchConditions(), 0],
    ),
  )
}

function client(logs: ReturnType<typeof log>[]): PublicClient {
  return {
    getBlockNumber: vi.fn().mockResolvedValue(100n),
    getCode: vi.fn(async ({ blockNumber }: { blockNumber?: bigint }) =>
      blockNumber !== undefined && blockNumber >= 10n ? '0x01' : '0x',
    ),
    getLogs: vi.fn().mockResolvedValue(logs),
  } as unknown as PublicClient
}

function verify(logs: ReturnType<typeof log>[]) {
  const publicClient = client(logs)
  return verifyExactAuthorizationManifest({
    publicClient,
    rolesModifierAddress: MODIFIER,
    botAddress: BOT,
    roleKey: ROLE,
    poolAddress: POOL,
    deploymentBlock: 10n,
  })
}

describe('exact authorization manifest', () => {
  const reviewed = [assign(BOT), enabled(BOT), scopeTarget(), scopeFunction()]

  it('accepts only the reviewed single-member single-pool loan role', async () => {
    await expect(verify(reviewed)).resolves.toBeUndefined()
  })

  it('rejects an extra member even when the reviewed probes would still pass', async () => {
    const logs = [...reviewed, assign(EXTRA), enabled(EXTRA)]
    await expect(verify(logs)).rejects.toThrow(`unexpected member ${EXTRA.toLowerCase()}`)
    const diff = await inspectExactAuthorizationManifest({
      publicClient: client(logs),
      rolesModifierAddress: MODIFIER,
      botAddress: BOT,
      roleKey: ROLE,
      poolAddress: POOL,
      deploymentBlock: 10n,
    })
    expect(formatAuthorizationManifestDiff(diff)).toContain(
      `unexpected enabled module ${EXTRA.toLowerCase()}`,
    )
  })

  it('rejects an extra keeper role assigned under a different role key', async () => {
    const extraRole = `0x${'66'.repeat(32)}` as Hex
    await expect(verify([...reviewed, assign(EXTRA, extraRole), enabled(EXTRA)])).rejects.toThrow(
      /does not exactly match/,
    )
  })

  it('rejects an extra target even when the reviewed target remains scoped', async () => {
    await expect(verify([...reviewed, scopeTarget(EXTRA)])).rejects.toThrow(
      /does not exactly match/,
    )
  })

  const deleveragerBundle = () => [
    assign(BOT, DELEVERAGER_ROLE_KEY),
    scopeTargetFor(DELEVERAGER_ROLE_KEY),
    deleveragerScopeFunction(),
  ]
  const verifyWithDeleverager = (logs: ReturnType<typeof log>[]) =>
    verifyExactAuthorizationManifest({
      publicClient: client(logs),
      rolesModifierAddress: MODIFIER,
      botAddress: BOT,
      roleKey: ROLE,
      poolAddress: POOL,
      deploymentBlock: 10n,
      deleverager: { member: BOT, roleKey: DELEVERAGER_ROLE_KEY },
    })

  it('accepts loan + burn-only deleverager when the deleverager arg is passed', async () => {
    await expect(
      verifyWithDeleverager([...reviewed, ...deleveragerBundle()]),
    ).resolves.toBeUndefined()
  })

  it('rejects the deleverager role on-chain when it was not expected', async () => {
    await expect(verify([...reviewed, ...deleveragerBundle()])).rejects.toThrow(
      /does not exactly match/,
    )
  })

  it('rejects when the deleverager was expected but is absent on-chain', async () => {
    await expect(verifyWithDeleverager(reviewed)).rejects.toThrow(/does not exactly match/)
  })
})

describe('SFPM authorization subset', () => {
  const params = {
    roleKey: ROLE,
    safe: SAFE,
    sfpm: SFPM,
    collateralTracker0: CT0,
    collateralTracker1: CT1,
    adapter: ADAPTER,
    poolIdPin: 123n,
    multiSendCallOnly: MULTISEND,
    multiSendUnwrapper: UNWRAPPER,
    nativeCollateral: 'token0' as const,
    weth9: WETH,
  }
  const reviewed = buildSfpmSwapVenueSteps(params).map(sfpmStepLog)
  const verifySfpm = (logs: ReturnType<typeof log>[]) =>
    verifySfpmSwapAuthorization({
      publicClient: client(logs),
      rolesModifierAddress: MODIFIER,
      deploymentBlock: 10n,
      ...params,
    })

  it('accepts the complete event-derived SFPM authorization subset', async () => {
    await expect(verifySfpm(reviewed)).resolves.toBeUndefined()
  })

  it('rejects a stale SFPM authorization subset', async () => {
    await expect(verifySfpm(reviewed.slice(0, -1))).rejects.toThrow(/missing or stale/)
  })

  it('admits the reviewed SFPM subset in the exact permission manifest', async () => {
    await expect(
      verifyExactAuthorizationManifest({
        publicClient: client([
          assign(BOT),
          enabled(BOT),
          scopeTarget(),
          scopeFunction(),
          ...reviewed,
        ]),
        rolesModifierAddress: MODIFIER,
        botAddress: BOT,
        roleKey: ROLE,
        poolAddress: POOL,
        deploymentBlock: 10n,
        sfpmSwap: params,
      }),
    ).resolves.toBeUndefined()
  })
})
