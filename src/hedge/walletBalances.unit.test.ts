import type { PublicClient } from 'viem'
import { describe, expect, it, vi } from 'vitest'

import { readSafeWalletBalances, spendableAfterCollateralReserve } from './walletBalances'

const SAFE = '0x1111111111111111111111111111111111111111'
const WETH = '0x2222222222222222222222222222222222222222'
const USDC = '0x3333333333333333333333333333333333333333'

describe('readSafeWalletBalances', () => {
  it('combines pinned ETH and WETH on the native side', async () => {
    const publicClient = {
      getBalance: vi.fn(async () => 3n),
      readContract: vi.fn(async ({ address }: { address: string }) =>
        address.toLowerCase() === WETH.toLowerCase() ? 5n : 7n,
      ),
    } as unknown as PublicClient

    const result = await readSafeWalletBalances({
      publicClient,
      safeAddress: SAFE,
      asset0: '0x0000000000000000000000000000000000000000',
      asset1: USDC,
      weth9: WETH,
      blockNumber: 123n,
    })

    expect(result).toEqual({
      token0: { token: 5n, native: 3n, total: 8n },
      token1: { token: 7n, native: 0n, total: 7n },
    })
    expect(publicClient.getBalance).toHaveBeenCalledWith({
      address: SAFE,
      blockNumber: 123n,
    })
    expect(publicClient.readContract).toHaveBeenCalledTimes(2)
    for (const [call] of publicClient.readContract.mock.calls) {
      expect(call).toMatchObject({ blockNumber: 123n })
    }
  })
})

describe('spendableAfterCollateralReserve', () => {
  it('retains a rounded-up 50bps reserve', () => {
    expect(spendableAfterCollateralReserve(10_000n)).toBe(9_950n)
    expect(spendableAfterCollateralReserve(250n)).toBe(248n)
    expect(spendableAfterCollateralReserve(200n)).toBe(199n)
    expect(spendableAfterCollateralReserve(1n)).toBe(0n)
  })

  it('validates inputs and supports an explicit zero reserve', () => {
    expect(spendableAfterCollateralReserve(123n, 0n)).toBe(123n)
    expect(() => spendableAfterCollateralReserve(-1n)).toThrow(/cannot be negative/)
    expect(() => spendableAfterCollateralReserve(1n, 10_001n)).toThrow(/between 0 and 10000/)
  })
})
