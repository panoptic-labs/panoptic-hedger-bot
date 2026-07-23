import type { PublicClient } from 'viem'
import { describe, expect, it, vi } from 'vitest'

import { readSafePositions } from './positionReader'
import { readHedgeSnapshot } from './snapshot'

const sdk = vi.hoisted(() => ({
  getBlockMeta: vi.fn(),
  getPool: vi.fn(),
  getAccountBuyingPower: vi.fn(),
  getAccountCollateral: vi.fn(),
  getCollateralAddresses: vi.fn(),
  isLiquidatable: vi.fn(),
}))

vi.mock('@panoptic-eng/sdk/v2', () => sdk)
vi.mock('./positionReader', () => ({ readSafePositions: vi.fn() }))

describe('readHedgeSnapshot', () => {
  it('pins every account read to one block and reads the pool once', async () => {
    const blockNumber = 456n
    const blockMeta = { blockNumber, blockHash: '0xabc', blockTimestamp: 1n }
    const positions = [{ tokenId: 7n, legs: [], positionSize: 1n, tickAtMint: 0n }]
    vi.mocked(readSafePositions).mockResolvedValue({ positions, hedgePositions: [] })
    sdk.getBlockMeta.mockResolvedValue(blockMeta)
    sdk.getPool.mockResolvedValue({ poolId: 1n })
    sdk.getCollateralAddresses.mockReturnValue(['0x01', '0x02'])
    sdk.getAccountBuyingPower.mockResolvedValue({})
    sdk.getAccountCollateral.mockResolvedValue({})
    sdk.isLiquidatable.mockResolvedValue({ isLiquidatable: false })
    const publicClient = {
      getBlockNumber: vi.fn(async () => blockNumber),
    } as unknown as PublicClient

    await readHedgeSnapshot({
      publicClient,
      poolAddress: '0x1111111111111111111111111111111111111111',
      safeAddress: '0x2222222222222222222222222222222222222222',
      chainId: 1n,
      storage: {} as never, // unused: readSafePositions is mocked
    })

    // The pin block is resolved by exactly one shared getBlockMeta call.
    expect(sdk.getBlockMeta).toHaveBeenCalledTimes(1)
    expect(sdk.getPool).toHaveBeenCalledTimes(1)
    for (const call of [
      vi.mocked(readSafePositions).mock.calls[0][0],
      sdk.getPool.mock.calls[0][0],
      sdk.getAccountBuyingPower.mock.calls[0][0],
      sdk.getAccountCollateral.mock.calls[0][0],
      sdk.isLiquidatable.mock.calls[0][0],
    ]) {
      expect(call).toMatchObject({ blockNumber })
    }
  })
})
