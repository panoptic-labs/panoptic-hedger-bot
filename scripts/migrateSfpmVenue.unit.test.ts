import { rolesV2Abi, WITHDRAW_WITH_POSITIONS_SELECTOR } from '@panoptic-eng/sdk/zodiac'
import { decodeFunctionData } from 'viem'
import { describe, expect, it } from 'vitest'

import type { SfpmSwapConfigureInput } from './lib/deployCore'
import { buildSfpmVenueMigrationCalls, parseSfpmMigrationConfig } from './migrateSfpmVenue'

const A = (digit: string) => `0x${digit.repeat(40)}` as `0x${string}`
const SAFE = A('1')
const MODIFIER = A('2')
const SFPM = A('3')
const CT0 = A('4')
const CT1 = A('5')
const WETH = A('6')
const USDC = A('7')
const ADAPTER = A('8')
const MULTISEND = A('9')
const UNWRAPPER = A('a')
const HANDLER = A('b')
const ROLE = `0x${'cc'.repeat(32)}` as `0x${string}`

const sfpmSwap: SfpmSwapConfigureInput = {
  sfpm: SFPM,
  collateralTracker0: CT0,
  collateralTracker1: CT1,
  adapter: ADAPTER,
  poolIdPin: 123n,
  multiSendCallOnly: MULTISEND,
  multiSendUnwrapper: UNWRAPPER,
  nativeCollateral: 'token0',
  weth9: WETH,
  approvals: [
    { token: USDC, spender: SFPM },
    { token: USDC, spender: CT1 },
    { token: WETH, spender: SFPM },
  ],
}

describe('SFPM venue migration batch', () => {
  it('can repair an enabled but not-yet-provisioned configuration', () => {
    expect(
      parseSfpmMigrationConfig({
        CHAIN_ID: '1',
        RPC_URL: 'https://rpc.example',
        POOL_ADDRESS: SAFE,
        SAFE_ADDRESS: SAFE,
        ROLES_MODIFIER_ADDRESS: MODIFIER,
        ROLE_KEY: ROLE,
        BOT_PRIVATE_KEY: `0x${'22'.repeat(32)}`,
        ASSET_INDEX: '1',
        SFPM_SWAP_ENABLED: 'true',
        SFPM_SWAP_PROVISIONED: 'false',
      }).SFPM_SWAP_ENABLED,
    ).toBe(false)
  })

  it('adds the complete venue surface to a Safe that started without it', () => {
    const calls = buildSfpmVenueMigrationCalls({
      safeAddress: SAFE,
      rolesModifierAddress: MODIFIER,
      roleKey: ROLE,
      sfpmSwap,
      fallbackHandler: HANDLER,
    })

    expect(calls).toHaveLength(16)
    expect(calls[0]).toMatchObject({
      to: SAFE,
      description: expect.stringContaining('CompatibilityFallbackHandler'),
    })
    expect(calls.some((call) => call.description.includes('setTransactionUnwrapper'))).toBe(true)
    expect(calls.some((call) => call.description.includes('SFPM.multicall'))).toBe(true)
    expect(calls.some((call) => call.description.includes('WETH9.deposit'))).toBe(true)
    expect(calls.some((call) => call.description.includes('WETH9.withdraw'))).toBe(true)
    expect(calls.filter((call) => call.description.startsWith('approve('))).toHaveLength(3)

    const scopedWithdrawals = calls.filter((call) => {
      if (call.to !== MODIFIER) return false
      const decoded = decodeFunctionData({ abi: rolesV2Abi, data: call.data })
      return decoded.functionName === 'scopeFunction' &&
        decoded.args[2] === WITHDRAW_WITH_POSITIONS_SELECTOR
        ? true
        : false
    })
    expect(scopedWithdrawals.map((call) => call.description)).toEqual([
      expect.stringContaining('CT0.withdraw'),
      expect.stringContaining('CT1.withdraw'),
    ])
  })

  it('does not replace an already-compatible Safe fallback handler', () => {
    const calls = buildSfpmVenueMigrationCalls({
      safeAddress: SAFE,
      rolesModifierAddress: MODIFIER,
      roleKey: ROLE,
      sfpmSwap,
    })

    expect(calls).toHaveLength(15)
    expect(calls.some((call) => call.description.includes('FallbackHandler'))).toBe(false)
  })
})
