import { decodeFunctionData, zeroAddress } from 'viem'
import { describe, expect, it } from 'vitest'

import { buildConfigureCalls, buildSafeSetupInitializer } from './deployCore'

const OWNER = '0x1111111111111111111111111111111111111111'
const SAFE = '0x2222222222222222222222222222222222222222'
const MODIFIER = '0x3333333333333333333333333333333333333333'
const BOT = '0x4444444444444444444444444444444444444444'
const POOL = '0x5555555555555555555555555555555555555555'
const HANDLER = '0x6666666666666666666666666666666666666666'
const ASSET = '0x8888888888888888888888888888888888888888'
const COLLATERAL_TRACKER = '0x9999999999999999999999999999999999999999'
const ROLE = `0x${'77'.repeat(32)}` as `0x${string}`

const safeConfigurationAbi = [
  {
    type: 'function',
    name: 'setup',
    stateMutability: 'nonpayable',
    inputs: [
      { name: '_owners', type: 'address[]' },
      { name: '_threshold', type: 'uint256' },
      { name: 'to', type: 'address' },
      { name: 'data', type: 'bytes' },
      { name: 'fallbackHandler', type: 'address' },
      { name: 'paymentToken', type: 'address' },
      { name: 'payment', type: 'uint256' },
      { name: 'paymentReceiver', type: 'address' },
    ],
    outputs: [],
  },
  {
    type: 'function',
    name: 'setFallbackHandler',
    stateMutability: 'nonpayable',
    inputs: [{ name: 'handler', type: 'address' }],
    outputs: [],
  },
] as const
const erc20ApproveAbi = [
  {
    type: 'function',
    name: 'approve',
    stateMutability: 'nonpayable',
    inputs: [
      { name: 'spender', type: 'address' },
      { name: 'amount', type: 'uint256' },
    ],
    outputs: [{ type: 'bool' }],
  },
] as const

describe('Safe onboarding configuration', () => {
  it('creates a fresh Safe with the reviewed fallback handler from birth', () => {
    const decoded = decodeFunctionData({
      abi: safeConfigurationAbi,
      data: buildSafeSetupInitializer(OWNER, HANDLER),
    })

    expect(decoded.functionName).toBe('setup')
    expect(decoded.args).toEqual([
      [OWNER],
      1n,
      zeroAddress,
      '0x',
      HANDLER,
      zeroAddress,
      0n,
      zeroAddress,
    ])
  })

  it('adds setFallbackHandler to an existing Safe owner batch when requested', () => {
    const calls = buildConfigureCalls({
      safeAddress: SAFE,
      rolesModifierAddress: MODIFIER,
      botAddress: BOT,
      roleKey: ROLE,
      poolAddress: POOL,
      fallbackHandler: HANDLER,
      includeEnableModule: false,
    })
    const fallbackCall = calls.find((call) => call.description.startsWith('setFallbackHandler'))
    if (fallbackCall === undefined) throw new Error('expected fallback-handler configure call')

    expect(fallbackCall.to).toBe(SAFE)
    expect(
      decodeFunctionData({
        abi: safeConfigurationAbi,
        data: fallbackCall.data,
      }),
    ).toEqual({
      functionName: 'setFallbackHandler',
      args: [HANDLER],
    })
  })

  it('adds collateral tracker approval to the Safe configure batch', () => {
    const calls = buildConfigureCalls({
      safeAddress: SAFE,
      rolesModifierAddress: MODIFIER,
      botAddress: BOT,
      roleKey: ROLE,
      poolAddress: POOL,
      collateralApprovals: [{ token: ASSET, spender: COLLATERAL_TRACKER }],
      includeEnableModule: false,
    })
    const approval = calls.find((call) => call.to === ASSET)
    if (approval === undefined) throw new Error('expected collateral approval call')

    expect(decodeFunctionData({ abi: erc20ApproveAbi, data: approval.data })).toEqual({
      functionName: 'approve',
      args: [COLLATERAL_TRACKER, (1n << 256n) - 1n],
    })
  })
})
