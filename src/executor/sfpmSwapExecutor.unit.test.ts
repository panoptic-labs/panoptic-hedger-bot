import type { Address, Hex } from 'viem'
import { decodeFunctionData, toFunctionSelector } from 'viem'
import { describe, expect, it, vi } from 'vitest'

import type { RolesCall, RolesExecutor } from '../safe/rolesExecutor'
import { type SfpmSwapExecutorDeps, createSfpmSwapExecutor } from './sfpmSwapExecutor'

const SFPM = '0x000000000000031d296bBA22f188472157eEb01f' as Address
const POOL = '0x88e6A0c2dDD26FEEb64F039a2c41296FcB3f5640' as Address
const SAFE = '0x1111111111111111111111111111111111111111' as Address
const CT0 = '0x2222222222222222222222222222222222222222' as Address // USDC CT
const CT1 = '0x3333333333333333333333333333333333333333' as Address // WETH/ETH CT
const TOKEN0 = '0x5555555555555555555555555555555555555555' as Address
const TOKEN1 = '0x6666666666666666666666666666666666666666' as Address
const WETH = '0xC02aaA39b223FE8D0A0e5C4F27eAD9083C756Cc2' as Address
const MULTISEND = '0x4444444444444444444444444444444444444444' as Address
const POOL_ID = 0xa0488e6a0c2ddn

const WITHDRAW = toFunctionSelector('withdraw(uint256,address,address,uint256[],bool)')
const DEPOSIT = toFunctionSelector('deposit(uint256,address)')
const WETH_DEPOSIT = toFunctionSelector('deposit()')
const WETH_WITHDRAW = toFunctionSelector('withdraw(uint256)')
const MULTICALL = toFunctionSelector('multicall(bytes[])')

const multiSendAbi = [
  {
    type: 'function',
    name: 'multiSend',
    stateMutability: 'payable',
    inputs: [{ name: 'transactions', type: 'bytes' }],
    outputs: [],
  },
] as const

interface Leg {
  op: number
  to: Address
  value: bigint
  selector: Hex
  dataLen: number
  data: Hex
}

function requireData(sent: { call?: RolesCall }): Hex {
  if (!sent.call) throw new Error('no RolesCall captured')
  return sent.call.data
}

/** Decode a Gnosis MultiSend `transactions` blob into its packed calls. */
function parseMultiSend(data: Hex): Leg[] {
  const { args } = decodeFunctionData({ abi: multiSendAbi, data })
  let hex = (args[0] as Hex).slice(2)
  const legs: Leg[] = []
  while (hex.length > 0) {
    const op = parseInt(hex.slice(0, 2), 16)
    const to = `0x${hex.slice(2, 42)}` as Address
    const value = BigInt(`0x${hex.slice(42, 106)}`)
    const len = Number(BigInt(`0x${hex.slice(106, 170)}`))
    const callData = `0x${hex.slice(170, 170 + len * 2)}` as Hex
    legs.push({
      op,
      to,
      value,
      selector: callData.slice(0, 10) as Hex,
      dataLen: len,
      data: callData,
    })
    hex = hex.slice(170 + len * 2)
  }
  return legs
}

function makeExecutor(overrides: Partial<SfpmSwapExecutorDeps>, sent: { call?: RolesCall }) {
  const rolesExecutor = {
    send: vi.fn(async (call: RolesCall) => {
      sent.call = call
      return { transactionHash: '0xabc' } as never
    }),
    simulate: vi.fn(async (call: RolesCall) => {
      sent.call = call
    }),
    wrapCalldata: vi.fn(),
    preflight: vi.fn(),
  } as unknown as RolesExecutor

  const deps: SfpmSwapExecutorDeps = {
    publicClient: {
      getStorageAt: vi.fn(
        async () => '0x0000000000000000000000009999999999999999999999999999999999999999',
      ),
      readContract: vi.fn(async () => '0xf23a6e61'),
      call: vi.fn(async () => ({ data: undefined })),
    } as never,
    safeAddress: SAFE,
    rolesExecutor,
    sfpmAddress: SFPM,
    swapPoolAddress: POOL,
    swapPoolId: POOL_ID,
    token0Collateral: { collateralTracker: CT0, asset: TOKEN0, native: false }, // USDC
    token1Collateral: { collateralTracker: CT1, asset: TOKEN1, native: false },
    weth9: WETH,
    slippageBps: 50n,
    multiSendCallOnly: MULTISEND,
    dryRun: false,
    walletBalanceReader: vi.fn(async () => ({
      token0: { token: 0n, native: 0n, total: 0n },
      token1: { token: 0n, native: 0n, total: 0n },
    })),
    ...overrides,
  }
  return { executor: createSfpmSwapExecutor(deps), rolesExecutor }
}

describe('createSfpmSwapExecutor', () => {
  it('ERC20↔ERC20: withdraw(in) → SFPM.multicall → deposit(out), no wrap, no value', async () => {
    const sent: { call?: RolesCall } = {}
    const { executor } = makeExecutor({}, sent)
    await executor.execute({
      sellToken0: true,
      kind: 'exactIn',
      amount: 1_000_000n,
      expectedAmountOut: 500_000_000_000_000_000n,
      currentTick: 201042,
      positionIdList: [11n, 22n],
    })

    expect(sent.call?.to).toBe(MULTISEND)
    expect(sent.call?.operation).toBe(1)
    expect(sent.call?.value).toBe(0n)
    const legs = parseMultiSend(requireData(sent))
    expect(legs.map((l) => l.selector)).toEqual([WITHDRAW, MULTICALL, DEPOSIT])
    expect(legs[0].to.toLowerCase()).toBe(CT0.toLowerCase()) // withdraw from token0 (USDC) CT
    expect(legs[1].to.toLowerCase()).toBe(SFPM.toLowerCase())
    expect(legs[2].to.toLowerCase()).toBe(CT1.toLowerCase()) // deposit to token1 CT
    expect(legs.every((l) => l.value === 0n)).toBe(true)
    const withdrawAbi = [
      {
        type: 'function',
        name: 'withdraw',
        stateMutability: 'nonpayable',
        inputs: [
          { name: 'assets', type: 'uint256' },
          { name: 'receiver', type: 'address' },
          { name: 'owner', type: 'address' },
          { name: 'positionIdList', type: 'uint256[]' },
          { name: 'usePremiaAsCollateral', type: 'bool' },
        ],
        outputs: [],
      },
    ] as const
    const withdrawal = decodeFunctionData({ abi: withdrawAbi, data: legs[0].data })
    expect(withdrawal.args).toEqual([1_000_000n, SAFE, SAFE, [11n, 22n], false])
    // deposit floor = amountOut − 50bps haircut = 0.5 − 0.25% = 0.4975 WETH
    const depositAbi = [
      {
        type: 'function',
        name: 'deposit',
        stateMutability: 'payable',
        inputs: [
          { name: 'assets', type: 'uint256' },
          { name: 'receiver', type: 'address' },
        ],
        outputs: [],
      },
    ] as const
    const decoded = decodeFunctionData({ abi: depositAbi, data: legs[2].data })
    const amountOut = 500_000_000_000_000_000n
    expect(decoded.args[0]).toBe(amountOut - (amountOut * 50n) / 10_000n)
  })

  it('uses loose input tokens first and withdraws only the remainder', async () => {
    const sent: { call?: RolesCall } = {}
    const { executor } = makeExecutor(
      {
        walletBalanceReader: vi.fn(async () => ({
          token0: { token: 400_000n, native: 0n, total: 400_000n },
          token1: { token: 0n, native: 0n, total: 0n },
        })),
      },
      sent,
    )
    await executor.execute({
      sellToken0: true,
      kind: 'exactIn',
      amount: 1_000_000n,
      expectedAmountOut: 400_000n,
      currentTick: 201042,
      positionIdList: [11n],
    })

    const legs = parseMultiSend(requireData(sent))
    const withdrawal = decodeFunctionData({
      abi: [
        {
          type: 'function',
          name: 'withdraw',
          stateMutability: 'nonpayable',
          inputs: [
            { name: 'assets', type: 'uint256' },
            { name: 'receiver', type: 'address' },
            { name: 'owner', type: 'address' },
            { name: 'positionIdList', type: 'uint256[]' },
            { name: 'usePremiaAsCollateral', type: 'bool' },
          ],
          outputs: [],
        },
      ] as const,
      data: legs[0].data,
    })
    expect(withdrawal.args[0]).toBe(600_000n)
  })

  it('skips the CT withdrawal when loose tokens cover the entire swap', async () => {
    const sent: { call?: RolesCall } = {}
    const { executor } = makeExecutor(
      {
        walletBalanceReader: vi.fn(async () => ({
          token0: { token: 1_000_000n, native: 0n, total: 1_000_000n },
          token1: { token: 0n, native: 0n, total: 0n },
        })),
      },
      sent,
    )
    await executor.execute({
      sellToken0: true,
      kind: 'exactIn',
      amount: 1_000_000n,
      expectedAmountOut: 400_000n,
      currentTick: 201042,
      positionIdList: [11n],
    })
    expect(parseMultiSend(requireData(sent)).map((leg) => leg.selector)).toEqual([
      MULTICALL,
      DEPOSIT,
    ])
  })

  it('native input (token0 native): inserts WETH.deposit{value: amountIn} before the swap', async () => {
    const sent: { call?: RolesCall } = {}
    const { executor } = makeExecutor(
      {
        token0Collateral: {
          collateralTracker: CT0,
          asset: '0x0000000000000000000000000000000000000000',
          native: true,
        },
      },
      sent,
    )
    await executor.execute({
      sellToken0: true,
      kind: 'exactIn',
      amount: 1_000_000n,
      expectedAmountOut: 400_000n,
      currentTick: 201042,
      positionIdList: [11n],
    })
    const legs = parseMultiSend(requireData(sent))
    expect(legs.map((l) => l.selector)).toEqual([WITHDRAW, WETH_DEPOSIT, MULTICALL, DEPOSIT])
    expect(legs[1].to.toLowerCase()).toBe(WETH.toLowerCase())
    expect(legs[1].value).toBe(1_000_000n) // wrap exactly amountIn
    expect(legs[3].value).toBe(0n) // ERC20 deposit, no value
  })

  it('native output (token1 native): inserts WETH.withdraw then a payable deposit', async () => {
    const sent: { call?: RolesCall } = {}
    const { executor } = makeExecutor(
      {
        token1Collateral: {
          collateralTracker: CT1,
          asset: '0x0000000000000000000000000000000000000000',
          native: true,
        },
      },
      sent,
    )
    await executor.execute({
      sellToken0: true,
      kind: 'exactIn',
      amount: 1_000_000n,
      expectedAmountOut: 400_000n,
      currentTick: 201042,
      positionIdList: [11n],
    })
    const legs = parseMultiSend(requireData(sent))
    expect(legs.map((l) => l.selector)).toEqual([WITHDRAW, MULTICALL, WETH_WITHDRAW, DEPOSIT])
    const minOut = 400_000n - (400_000n * 50n) / 10_000n
    expect(legs[2].to.toLowerCase()).toBe(WETH.toLowerCase())
    expect(legs[3].value).toBe(minOut) // native CT deposit is payable, value == minOut
  })

  it('redeposits ERC20 plus combined ETH/WETH wallet balances atomically', async () => {
    const sent: { call?: RolesCall } = {}
    const { executor } = makeExecutor(
      {
        token1Collateral: {
          collateralTracker: CT1,
          asset: '0x0000000000000000000000000000000000000000',
          native: true,
        },
        walletBalanceReader: vi.fn(async () => ({
          token0: { token: 100n, native: 0n, total: 100n },
          token1: { token: 20n, native: 30n, total: 50n },
        })),
      },
      sent,
    )

    const result = await executor.redepositWalletBalances()
    const legs = parseMultiSend(requireData(sent))
    expect(legs.map((leg) => leg.selector)).toEqual([DEPOSIT, WETH_WITHDRAW, DEPOSIT])
    expect(legs[0].to.toLowerCase()).toBe(CT0.toLowerCase())
    expect(legs[1].to.toLowerCase()).toBe(WETH.toLowerCase())
    expect(legs[2].to.toLowerCase()).toBe(CT1.toLowerCase())
    expect(legs[2].value).toBe(50n)
    expect(result).toMatchObject({ depositedToken0: 100n, depositedToken1: 50n })
  })

  it('dry-run uses simulate, not send', async () => {
    const sent: { call?: RolesCall } = {}
    const { executor, rolesExecutor } = makeExecutor({ dryRun: true }, sent)
    const res = await executor.execute({
      sellToken0: false,
      kind: 'exactIn',
      amount: 500_000n,
      expectedAmountOut: 300_000n,
      currentTick: 201042,
      positionIdList: [11n],
    })
    expect(res.dryRun).toBe(true)
    expect(res.transactionHash).toBeNull()
    expect(rolesExecutor.simulate).toHaveBeenCalledOnce()
    expect(rolesExecutor.send).not.toHaveBeenCalled()
  })

  const req = {
    sellToken0: true,
    kind: 'exactIn' as const,
    amount: 1_000_000n,
    expectedAmountOut: 400_000n,
    currentTick: 201042,
    positionIdList: [11n],
  }

  it('simulate() resolves when the MultiSend would succeed', async () => {
    const { executor, rolesExecutor } = makeExecutor({}, {})
    ;(rolesExecutor.simulate as ReturnType<typeof vi.fn>).mockResolvedValueOnce(undefined)
    await expect(executor.simulate(req)).resolves.toBeUndefined()
    expect(rolesExecutor.send).not.toHaveBeenCalled()
  })

  it('simulate() preserves the revert when the MultiSend fails', async () => {
    const { executor, rolesExecutor } = makeExecutor({}, {})
    ;(rolesExecutor.simulate as ReturnType<typeof vi.fn>).mockRejectedValueOnce(
      new Error('ConditionViolation'),
    )
    await expect(executor.simulate(req)).rejects.toThrow('ConditionViolation')
  })

  it('simulate() surfaces a decoded input CollateralTracker withdrawal failure', async () => {
    const { executor, rolesExecutor } = makeExecutor(
      {
        publicClient: {
          getStorageAt: vi.fn(
            async () => '0x0000000000009999999999999999999999999999999999999999999999999999',
          ),
          readContract: vi.fn(async () => '0xf23a6e61'),
          call: vi.fn(async () => {
            throw { data: '0x20adf2ea' }
          }),
        } as never,
      },
      {},
    )

    await expect(executor.simulate(req)).rejects.toThrow(
      /ExceedsMaximumRedemption.*maximum available/,
    )
    expect(rolesExecutor.simulate).not.toHaveBeenCalled()
  })

  it('simulate() reports a missing Safe ERC-1155 fallback handler before Roles', async () => {
    const { executor, rolesExecutor } = makeExecutor(
      {
        publicClient: {
          getStorageAt: vi.fn(
            async () => '0x0000000000000000000000000000000000000000000000000000000000000000',
          ),
        } as never,
      },
      {},
    )
    await expect(executor.simulate(req)).rejects.toThrow('has no fallback handler')
    expect(rolesExecutor.simulate).not.toHaveBeenCalled()
  })
})
