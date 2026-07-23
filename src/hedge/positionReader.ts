import {
  type BlockMeta,
  type StorageAdapter,
  getPositions,
  syncPositions,
} from '@panoptic-eng/sdk/v2'
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
   * uses a file-backed adapter, so restarts resume the event scan incrementally
   * from the persisted checkpoint instead of re-scanning from genesis.
   */
  storage: StorageAdapter
  /** Block floor for the first (full) position-event scan. */
  fromBlock?: bigint
  /** Block at which every position read is pinned. */
  blockNumber?: bigint
  /** Pre-fetched block metadata (skips the SDK's per-read getBlockMeta call). */
  blockMeta?: BlockMeta
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

  // One batched getFullPositionsData read for the whole book (the SDK drops
  // zero-size positions), instead of one eth_call per open id.
  const fetched = await getPositions({
    client: asSdkClient<typeof getPositions>(publicClient),
    poolAddress,
    owner: safeAddress,
    tokenIds: openIds,
    blockNumber,
    _meta: deps.blockMeta,
  })

  const positions: PositionSnapshot[] = fetched.positions.map((pos) => ({
    tokenId: pos.tokenId,
    legs: pos.legs,
    positionSize: pos.positionSize,
    tickAtMint: pos.tickAtMint,
  }))

  const hedgePositions = positions.filter((position) => isLoanPosition(position.legs))

  return { positions, hedgePositions }
}
