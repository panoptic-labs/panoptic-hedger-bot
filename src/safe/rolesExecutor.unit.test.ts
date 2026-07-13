import type { Account, Address, Hex } from 'viem'
import { decodeFunctionData, toFunctionSelector } from 'viem'
import { describe, expect, it, vi } from 'vitest'

import { rolesModifierV2Abi } from './rolesAbi'
import { type RolesCall, type RolesExecutorDeps, createRolesExecutor } from './rolesExecutor'

const ROLES_MODIFIER: Address = '0x0000000000000000000000000000000000000AbC'
const SAFE: Address = '0x1111111111111111111111111111111111111111'
const POOL: Address = '0x2222222222222222222222222222222222222222'
const ROLE_KEY: Hex = ('0x' + 'ab'.repeat(32)) as Hex
const BOT: Address = '0x3333333333333333333333333333333333333333'

const DISPATCH_DATA: Hex = '0xdeadbeef'

const account = { address: BOT, type: 'json-rpc' } as unknown as Account

const CALL: RolesCall = { to: POOL, value: 0n, data: DISPATCH_DATA, operation: 0 }

function makeDeps(overrides: Partial<RolesExecutorDeps> = {}): RolesExecutorDeps {
  return {
    publicClient: {} as RolesExecutorDeps['publicClient'],
    walletClient: {} as RolesExecutorDeps['walletClient'],
    account,
    rolesModifierAddress: ROLES_MODIFIER,
    roleKey: ROLE_KEY,
    safeAddress: SAFE,
    ...overrides,
  }
}

describe('RolesExecutor.wrapCalldata', () => {
  it('encodes execTransactionWithRole with the correct selector', () => {
    const exec = createRolesExecutor(makeDeps())
    const data = exec.wrapCalldata(CALL)
    const expectedSelector = toFunctionSelector(
      'execTransactionWithRole(address,uint256,bytes,uint8,bytes32,bool)',
    )
    expect(data.slice(0, 10)).toBe(expectedSelector)
  })

  it('round-trips all six args, forcing shouldRevert=true and the configured roleKey', () => {
    const exec = createRolesExecutor(makeDeps())
    const data = exec.wrapCalldata(CALL)

    const decoded = decodeFunctionData({ abi: rolesModifierV2Abi, data })
    expect(decoded.functionName).toBe('execTransactionWithRole')
    const [to, value, callData, operation, roleKey, shouldRevert] = decoded.args as [
      Address,
      bigint,
      Hex,
      number,
      Hex,
      boolean,
    ]
    expect(to.toLowerCase()).toBe(POOL.toLowerCase())
    expect(value).toBe(0n)
    expect(callData).toBe(DISPATCH_DATA)
    expect(operation).toBe(0)
    expect(roleKey).toBe(ROLE_KEY)
    expect(shouldRevert).toBe(true)
  })
})

describe('RolesExecutor.send', () => {
  it('sends the wrapped calldata to the modifier from the bot account', async () => {
    const sendTransaction = vi.fn().mockResolvedValue('0xhash')
    const exec = createRolesExecutor(
      makeDeps({
        walletClient: { sendTransaction, chain: null } as never,
      }),
    )
    const hash = await exec.send(CALL)
    expect(hash).toBe('0xhash')
    expect(sendTransaction).toHaveBeenCalledTimes(1)
    const arg = sendTransaction.mock.calls[0][0]
    expect(arg.to).toBe(ROLES_MODIFIER)
    expect(arg.value).toBe(0n)
    expect(arg.account).toBe(account)
    expect(arg.data).toBe(exec.wrapCalldata(CALL))
  })
})

describe('RolesExecutor.simulate', () => {
  it('eth_calls the modifier from the bot address', async () => {
    const call = vi.fn().mockResolvedValue({ data: '0x' })
    const exec = createRolesExecutor(makeDeps({ publicClient: { call } as never }))
    await exec.simulate(CALL)
    const arg = call.mock.calls[0][0]
    expect(arg.to).toBe(ROLES_MODIFIER)
    expect(arg.account).toBe(BOT)
    expect(arg.data).toBe(exec.wrapCalldata(CALL))
  })

  it('propagates a revert as a thrown error', async () => {
    const call = vi.fn().mockRejectedValue(new Error('NotAuthorized()'))
    const exec = createRolesExecutor(makeDeps({ publicClient: { call } as never }))
    await expect(exec.simulate(CALL)).rejects.toThrow(/NotAuthorized/)
  })
})

describe('RolesExecutor.preflight', () => {
  it('passes when the modifier is deployed and avatar/target both equal the Safe', async () => {
    const publicClient = {
      getCode: vi.fn().mockResolvedValue('0x60016001'),
      readContract: vi.fn().mockResolvedValue(SAFE),
    }
    const exec = createRolesExecutor(makeDeps({ publicClient: publicClient as never }))
    await expect(exec.preflight()).resolves.toBeUndefined()
    expect(publicClient.getCode).toHaveBeenCalledWith({ address: ROLES_MODIFIER })
  })

  it('throws when the modifier has no bytecode', async () => {
    const publicClient = {
      getCode: vi.fn().mockResolvedValue('0x'),
      readContract: vi.fn(),
    }
    const exec = createRolesExecutor(makeDeps({ publicClient: publicClient as never }))
    await expect(exec.preflight()).rejects.toThrow(/no bytecode/)
  })

  it('throws when avatar does not match the Safe', async () => {
    const publicClient = {
      getCode: vi.fn().mockResolvedValue('0x60016001'),
      readContract: vi
        .fn()
        .mockResolvedValueOnce('0x9999999999999999999999999999999999999999') // avatar
        .mockResolvedValueOnce(SAFE), // target
    }
    const exec = createRolesExecutor(makeDeps({ publicClient: publicClient as never }))
    await expect(exec.preflight()).rejects.toThrow(/avatar/)
  })
})
