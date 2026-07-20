import type { PublicClient } from 'viem'
import { beforeEach, describe, expect, it, vi } from 'vitest'

import { readSafePositions } from './positionReader'

const sdk = vi.hoisted(() => ({
  syncPositions: vi.fn(),
  getPosition: vi.fn(),
}))

vi.mock('@panoptic-eng/sdk/v2', () => sdk)

const SAFE = '0x2222222222222222222222222222222222222222' as const
const POOL = '0x1111111111111111111111111111111111111111' as const

function deps() {
  return {
    publicClient: {} as unknown as PublicClient,
    poolAddress: POOL,
    chainId: 1n,
    safeAddress: SAFE,
    storage: {} as never,
    fromBlock: 0n,
    blockNumber: 100n,
  }
}

beforeEach(() => {
  vi.clearAllMocks()
})

describe('readSafePositions', () => {
  it('threads every synced position id (no drop) and splits loans from options', async () => {
    // Mirrors the incident: an option (width>0) plus width-0 hedge loans, one of
    // which is a non-bot position the old discovery dropped.
    const option = { tokenId: 1n, legs: [{ width: 12n }, { width: 12n }], positionSize: 5n }
    const loanA = { tokenId: 2n, legs: [{ width: 0n }], positionSize: 3n }
    const loanB = { tokenId: 3n, legs: [{ width: 0n }], positionSize: 4n }
    const settled = { tokenId: 4n, legs: [{ width: 0n }], positionSize: 0n } // dropped
    const byId: Record<string, (typeof option)[]> = {}
    for (const p of [option, loanA, loanB, settled]) byId[p.tokenId.toString()] = [p]

    sdk.syncPositions.mockResolvedValue({ positionIds: [1n, 2n, 3n, 4n] })
    sdk.getPosition.mockImplementation(async ({ tokenId }: { tokenId: bigint }) => ({
      legs: byId[tokenId.toString()][0].legs,
      positionSize: byId[tokenId.toString()][0].positionSize,
      tickAtMint: 0n,
    }))

    const { positions, hedgePositions } = await readSafePositions(deps())

    // Size-0 position filtered; all non-empty synced ids present.
    expect(positions.map((p) => p.tokenId)).toEqual([1n, 2n, 3n])
    // Only width-0 positions are hedge loans; the option is excluded.
    expect(hedgePositions.map((p) => p.tokenId)).toEqual([2n, 3n])
  })

  it('propagates a syncPositions failure (never proceeds on an unknown set)', async () => {
    sdk.syncPositions.mockRejectedValue(new Error('sync timeout'))
    await expect(readSafePositions(deps())).rejects.toThrow('sync timeout')
    expect(sdk.getPosition).not.toHaveBeenCalled()
  })
})
