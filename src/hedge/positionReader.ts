import { type StorageAdapter, getPosition, syncPositions } from '@panoptic-eng/sdk/v2'
import type { Address, PublicClient } from 'viem'

import { asSdkClient } from '../utils/sdkClient'
import { type PositionSnapshot, isLoanPosition } from './frame'

export interface ReadSafePositionsDeps {
  publicClient: PublicClient
  poolAddress: Address
  chainId: bigint
  /** The Safe account holding the options + hedge loans. */
  safeAddress: Address
  /**
   * Persistence for the SDK position sync (checkpoint + cached list). The bot
   * uses an in-memory adapter, so each process start does a full event scan and
   * subsequent cycles sync incrementally within the run.
   */
  storage: StorageAdapter
  /** Block floor for the first (full) position-event scan. */
  fromBlock?: bigint
  /** Block at which every position read is pinned. */
  blockNumber?: bigint
}

export interface SafePositions {
  /** All non-empty open positions held by the Safe. */
  positions: PositionSnapshot[]
  /** Subset classified as the bot's hedge loans. */
  hedgePositions: PositionSnapshot[]
}

/**
 * Read the Safe's open positions and split them into the option book and the
 * hedge-loan book. Every width-zero position is treated as a hedge loan.
 */
export async function readSafePositions(deps: ReadSafePositionsDeps): Promise<SafePositions> {
  const { publicClient, poolAddress, chainId, safeAddress, storage, fromBlock, blockNumber } = deps

  // Authoritative open-position set from the SDK sync (event-scan reconstruction
  // anchored to the latest dispatch by ANY actor — captures positions the bot
  // did not itself mint, unlike a scan pinned to the bot's own last dispatch).
  const { positionIds: openIds } = await syncPositions({
    client: asSdkClient<typeof syncPositions>(publicClient),
    chainId,
    poolAddress,
    account: safeAddress,
    storage,
    fromBlock,
    toBlock: blockNumber,
  })

  // Fan out the per-position reads in parallel — sequential awaits add a full
  // RPC round-trip of latency per open id on every hedge cycle.
  const fetched = await Promise.all(
    openIds.map((tokenId) =>
      getPosition({
        client: asSdkClient<typeof getPosition>(publicClient),
        poolAddress,
        owner: safeAddress,
        tokenId,
        blockNumber,
      }).then((pos) => ({ tokenId, pos })),
    ),
  )

  const positions: PositionSnapshot[] = []
  for (const { tokenId, pos } of fetched) {
    if (pos.positionSize === 0n) continue
    positions.push({
      tokenId,
      legs: pos.legs,
      positionSize: pos.positionSize,
      tickAtMint: pos.tickAtMint,
    })
  }

  const hedgePositions = positions.filter((position) => isLoanPosition(position.legs))

  return { positions, hedgePositions }
}
