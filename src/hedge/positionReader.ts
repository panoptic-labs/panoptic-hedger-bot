import { getOpenPositionIds, getPosition } from '@panoptic-eng/sdk/v2'
import type { Address, Hex, PublicClient } from 'viem'

import { asSdkClient } from '../utils/sdkClient'
import { type PositionSnapshot, isLoanPosition } from './frame'

export interface ReadSafePositionsDeps {
  publicClient: PublicClient
  poolAddress: Address
  chainId: bigint
  /** The Safe account holding the options + hedge loans. */
  safeAddress: Address
  /** Tracked hedge tokenIds (authoritative when non-empty; else re-derived). */
  trackedHedgeIds: Set<bigint>
  /** Hash of the last dispatch tx so position discovery waits past it. */
  lastDispatchTxHash?: Hex
}

export interface SafePositions {
  /** All non-empty open positions held by the Safe. */
  positions: PositionSnapshot[]
  /** Subset classified as the bot's hedge loans. */
  hedgePositions: PositionSnapshot[]
}

/**
 * Read the Safe's open positions and split them into the option book and the
 * hedge-loan book. Hedges are identified by the tracked set when available;
 * otherwise (e.g. after a restart) every pure width=0 loan position is treated
 * as a hedge — a documented v1 simplification (no storage dependency).
 */
export async function readSafePositions(deps: ReadSafePositionsDeps): Promise<SafePositions> {
  const { publicClient, poolAddress, chainId, safeAddress, trackedHedgeIds, lastDispatchTxHash } =
    deps

  const openIds =
    (await getOpenPositionIds({
      client: asSdkClient<typeof getOpenPositionIds>(publicClient),
      chainId,
      poolAddress,
      account: safeAddress,
      lastDispatchTxHash,
    })) ?? []

  // Fan out the per-position reads in parallel — sequential awaits add a full
  // RPC round-trip of latency per open id on every hedge cycle.
  const fetched = await Promise.all(
    openIds.map((tokenId) =>
      getPosition({
        client: asSdkClient<typeof getPosition>(publicClient),
        poolAddress,
        owner: safeAddress,
        tokenId,
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

  const useTracked = trackedHedgeIds.size > 0
  const hedgePositions = positions.filter((p) =>
    useTracked ? trackedHedgeIds.has(p.tokenId) : isLoanPosition(p.legs),
  )

  return { positions, hedgePositions }
}
