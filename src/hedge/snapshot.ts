import {
  type PoolMetadata,
  type StorageAdapter,
  getAccountBuyingPower,
  getAccountCollateral,
  getBlockMeta,
  getCollateralAddresses,
  getPool,
  isLiquidatable,
} from '@panoptic-eng/sdk/v2'
import type { Address, PublicClient } from 'viem'

import { asSdkClient } from '../utils/sdkClient'
import { type LpPositionForHedge, readSafeLpPositions } from './lpPositions'
import { readSafePositions } from './positionReader'

/** Uniswap LP positions folded into the hedge delta, plus their freshness. */
export interface HedgeSnapshotLp {
  /** Same-pair LP positions owned by the Safe and/or configured LP owner. */
  positions: LpPositionForHedge[]
  /** LP subgraph indexed head block. */
  headBlock: bigint
  /**
   * True when the LP data is trustworthy for hedging: the subgraph query
   * succeeded AND its head is within maxLagBlocks of chain head. When false,
   * LP delta must be treated as observe-only (not applied to the hedge).
   */
  fresh: boolean
}

export interface HedgeSnapshot {
  blockNumber: bigint
  positions: Awaited<ReturnType<typeof readSafePositions>>['positions']
  hedgePositions: Awaited<ReturnType<typeof readSafePositions>>['hedgePositions']
  pool: Awaited<ReturnType<typeof getPool>>
  buyingPower: Awaited<ReturnType<typeof getAccountBuyingPower>>
  collateral: Awaited<ReturnType<typeof getAccountCollateral>>
  liquidation: Awaited<ReturnType<typeof isLiquidatable>>
  /** Present only when LP tracking is configured (lpSubgraphUrl set). */
  lp?: HedgeSnapshotLp
}

export interface ReadHedgeSnapshotDeps {
  publicClient: PublicClient
  poolAddress: Address
  chainId: bigint
  safeAddress: Address
  blockNumber?: bigint
  /**
   * Immutable pool metadata fetched once at startup — passing it here stops
   * getPool from re-reading addresses/decimals/symbols every cycle.
   */
  poolMetadata?: PoolMetadata
  /** Persistence for the SDK position sync (file-backed in the bot). */
  storage: StorageAdapter
  /** Block floor for the first (full) position-event scan. */
  fromBlock?: bigint
  /** Uniswap LP tracking (folded into hedge delta when enabled + fresh). */
  lp?: {
    subgraphUrl: string
    /** Addresses to scan: the Safe plus any configured extra LP owner. */
    owners: Address[]
    maxLagBlocks: bigint
    /** Injectable for tests; defaults to the global fetch in readSafeLpPositions. */
    fetcher?: typeof fetch
  }
}

/** Read one internally consistent account snapshot for planning and diagnostics. */
export async function readHedgeSnapshot(deps: ReadHedgeSnapshotDeps): Promise<HedgeSnapshot> {
  // One getBlock resolves the pin block AND the shared BlockMeta every SDK read
  // below accepts — without it each read fetches its own block metadata.
  const blockMeta = await getBlockMeta({
    client: asSdkClient<typeof getBlockMeta>(deps.publicClient),
    blockNumber: deps.blockNumber,
  })
  const blockNumber = blockMeta.blockNumber
  const [positions, pool] = await Promise.all([
    readSafePositions({
      publicClient: deps.publicClient,
      poolAddress: deps.poolAddress,
      chainId: deps.chainId,
      safeAddress: deps.safeAddress,
      storage: deps.storage,
      fromBlock: deps.fromBlock,
      blockNumber,
      blockMeta,
    }),
    getPool({
      client: asSdkClient<typeof getPool>(deps.publicClient),
      poolAddress: deps.poolAddress,
      chainId: deps.chainId,
      blockNumber,
      poolMetadata: deps.poolMetadata,
      _meta: blockMeta,
    }),
  ])
  const tokenIds = positions.positions.map((position) => position.tokenId)
  // The LP subgraph read only needs `pool` (resolved above), so run it alongside
  // the account reads rather than serially after them.
  const lpDeps = deps.lp
  const [buyingPower, collateral, liquidation, lpResult] = await Promise.all([
    getAccountBuyingPower({
      client: asSdkClient<typeof getAccountBuyingPower>(deps.publicClient),
      poolAddress: deps.poolAddress,
      account: deps.safeAddress,
      tokenIds,
      blockNumber,
      _meta: blockMeta,
    }),
    getAccountCollateral({
      client: asSdkClient<typeof getAccountCollateral>(deps.publicClient),
      poolAddress: deps.poolAddress,
      account: deps.safeAddress,
      collateralAddresses: getCollateralAddresses(pool),
      blockNumber,
      _meta: blockMeta,
    }),
    isLiquidatable({
      client: asSdkClient<typeof isLiquidatable>(deps.publicClient),
      poolAddress: deps.poolAddress,
      account: deps.safeAddress,
      tokenIds,
      blockNumber,
      _meta: blockMeta,
    }),
    lpDeps
      ? readSafeLpPositions({
          url: lpDeps.subgraphUrl,
          owners: lpDeps.owners,
          token0: pool.poolKey.currency0,
          token1: pool.poolKey.currency1,
          fetcher: lpDeps.fetcher,
        })
      : undefined,
  ])

  let lp: HedgeSnapshotLp | undefined
  if (lpDeps && lpResult) {
    const lag = blockNumber - lpResult.headBlock
    const fresh = lpResult.ok && lpResult.headBlock > 0n && lag <= lpDeps.maxLagBlocks
    lp = { positions: lpResult.positions, headBlock: lpResult.headBlock, fresh }
  }

  return { blockNumber, ...positions, pool, buyingPower, collateral, liquidation, lp }
}
