/**
 * Per-chain block floor for Panoptic position-event scans. Mirrors the UI's
 * `PROTOCOL_GENESIS_BLOCK` (apps/panoptic-ui/app/utils/constants.tsx) so the
 * bot's `syncPositions` first (full) scan starts near protocol deployment
 * instead of block 0. In-memory storage means every process start re-scans, so
 * a tight floor keeps startup fast. `SYNC_FROM_BLOCK` overrides this per deploy.
 */
const PROTOCOL_GENESIS_BLOCK: Record<number, bigint> = {
  1: 21_430_593n, // mainnet
  130: 8_579_862n, // unichain
  8453: 29_634_150n, // base
}

/** Genesis block floor for `chainId`, or `0n` when unknown. */
export function protocolGenesisBlock(chainId: number): bigint {
  return PROTOCOL_GENESIS_BLOCK[chainId] ?? 0n
}
