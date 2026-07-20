import {
  type StorageAdapter,
  getAccountBuyingPower,
  getAccountCollateral,
  getCollateralAddresses,
  getPool,
  isLiquidatable,
} from '@panoptic-eng/sdk/v2'
import type { Address, PublicClient } from 'viem'

import { asSdkClient } from '../utils/sdkClient'
import { readSafePositions } from './positionReader'

export interface HedgeSnapshot {
  blockNumber: bigint
  positions: Awaited<ReturnType<typeof readSafePositions>>['positions']
  hedgePositions: Awaited<ReturnType<typeof readSafePositions>>['hedgePositions']
  pool: Awaited<ReturnType<typeof getPool>>
  buyingPower: Awaited<ReturnType<typeof getAccountBuyingPower>>
  collateral: Awaited<ReturnType<typeof getAccountCollateral>>
  liquidation: Awaited<ReturnType<typeof isLiquidatable>>
}

export interface ReadHedgeSnapshotDeps {
  publicClient: PublicClient
  poolAddress: Address
  chainId: bigint
  safeAddress: Address
  blockNumber?: bigint
  /** Persistence for the SDK position sync (in-memory in the bot). */
  storage: StorageAdapter
  /** Block floor for the first (full) position-event scan. */
  fromBlock?: bigint
}

/** Read one internally consistent account snapshot for planning and diagnostics. */
export async function readHedgeSnapshot(deps: ReadHedgeSnapshotDeps): Promise<HedgeSnapshot> {
  const blockNumber = deps.blockNumber ?? (await deps.publicClient.getBlockNumber())
  const [positions, pool] = await Promise.all([
    readSafePositions({
      publicClient: deps.publicClient,
      poolAddress: deps.poolAddress,
      chainId: deps.chainId,
      safeAddress: deps.safeAddress,
      storage: deps.storage,
      fromBlock: deps.fromBlock,
      blockNumber,
    }),
    getPool({
      client: asSdkClient<typeof getPool>(deps.publicClient),
      poolAddress: deps.poolAddress,
      chainId: deps.chainId,
      blockNumber,
    }),
  ])
  const tokenIds = positions.positions.map((position) => position.tokenId)
  const [buyingPower, collateral, liquidation] = await Promise.all([
    getAccountBuyingPower({
      client: asSdkClient<typeof getAccountBuyingPower>(deps.publicClient),
      poolAddress: deps.poolAddress,
      account: deps.safeAddress,
      tokenIds,
      blockNumber,
    }),
    getAccountCollateral({
      client: asSdkClient<typeof getAccountCollateral>(deps.publicClient),
      poolAddress: deps.poolAddress,
      account: deps.safeAddress,
      collateralAddresses: getCollateralAddresses(pool),
      blockNumber,
    }),
    isLiquidatable({
      client: asSdkClient<typeof isLiquidatable>(deps.publicClient),
      poolAddress: deps.poolAddress,
      account: deps.safeAddress,
      tokenIds,
      blockNumber,
    }),
  ])

  return { blockNumber, ...positions, pool, buyingPower, collateral, liquidation }
}
