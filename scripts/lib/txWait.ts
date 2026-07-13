import type { Hash, PublicClient, TransactionReceipt } from 'viem'
import { WaitForTransactionReceiptTimeoutError } from 'viem'

import { sleep } from '../../src/utils/sleep'

/**
 * EIP-1559 fee override for a deploy transaction. Always carries a NON-ZERO
 * priority tip: the mainnet onboarding failure came from viem/RPC estimating a
 * `maxPriorityFeePerGas` of 0, which left the txs un-prioritised and slow to
 * include — long enough to blow the receipt-wait timeout.
 */
export interface TxFees {
  maxFeePerGas: bigint
  maxPriorityFeePerGas: bigint
}

export interface FeeOptions {
  /** Floor for the priority tip (wei). Guards against estimators returning 0. */
  priorityFloorWei?: bigint
  /** Hard cap on the priority tip (wei). Clamps a hot estimate. */
  priorityCapWei?: bigint
  /** Hard cap on maxFeePerGas (wei). */
  maxFeeCapWei?: bigint
  /**
   * baseFee headroom multiplier for maxFeePerGas. Fractional values are
   * honoured (e.g. `1.5` → 1.5× baseFee) via fixed-point milli-unit scaling;
   * clamped to a minimum of 1.0 so the cap always covers the base fee.
   */
  baseFeeMultiplier?: number
}

const GWEI = 1_000_000_000n
/**
 * 0.1 gwei — a small always-nonzero tip so a tx is never sent with a zero tip
 * (the onboarding failure), while staying close to a normal wallet's default.
 */
export const DEFAULT_PRIORITY_FLOOR_WEI = GWEI / 10n
/**
 * 1 gwei — ordinary tip ceiling for setup txs (which are not latency-critical).
 * The estimate is clamped into [floor, cap]; raise via feeOptions for urgency.
 */
export const DEFAULT_PRIORITY_CAP_WEI = GWEI
/** 400 gwei ceiling, matching the runtime bot's MAX_FEE_GWEI default. */
export const DEFAULT_MAX_FEE_CAP_WEI = 400n * GWEI
export const DEFAULT_TX_TIMEOUT_MS = 180_000

/**
 * Resolve EIP-1559 fees from the latest block, clamping the priority tip into
 * `[priorityFloorWei, priorityCapWei]` — the floor rules out a zero-tip send,
 * the cap keeps a hot estimator from overpaying on a non-urgent setup tx.
 * `maxFeePerGas = baseFee * mult + tip`, capped at `maxFeeCapWei`.
 */
export async function resolveTxFees(
  publicClient: PublicClient,
  opts: FeeOptions = {},
): Promise<TxFees> {
  const priorityFloor = opts.priorityFloorWei ?? DEFAULT_PRIORITY_FLOOR_WEI
  const priorityCap = opts.priorityCapWei ?? DEFAULT_PRIORITY_CAP_WEI
  const maxFeeCap = opts.maxFeeCapWei ?? DEFAULT_MAX_FEE_CAP_WEI
  // Preserve fractional multipliers by scaling in milli-units (× 1000).
  const multMilli = BigInt(Math.max(1000, Math.round((opts.baseFeeMultiplier ?? 2) * 1000)))

  const block = await publicClient.getBlock({ blockTag: 'latest' })
  const baseFee = block.baseFeePerGas ?? 0n

  let estimated = 0n
  try {
    estimated = await publicClient.estimateMaxPriorityFeePerGas()
  } catch {
    // Some RPCs don't support eth_maxPriorityFeePerGas — the floor covers us.
  }
  // Clamp into [floor, cap]. If floor > cap (custom config), the floor wins.
  let maxPriorityFeePerGas = estimated < priorityFloor ? priorityFloor : estimated
  if (maxPriorityFeePerGas > priorityCap && priorityCap >= priorityFloor) {
    maxPriorityFeePerGas = priorityCap
  }

  let maxFeePerGas = (baseFee * multMilli) / 1000n + maxPriorityFeePerGas
  if (maxFeePerGas > maxFeeCap) maxFeePerGas = maxFeeCap
  // maxFeePerGas must always cover the tip.
  if (maxFeePerGas < maxPriorityFeePerGas) maxFeePerGas = maxPriorityFeePerGas
  return { maxFeePerGas, maxPriorityFeePerGas }
}

/**
 * Wait for a receipt, but treat a client-side timeout as "maybe still pending"
 * rather than a hard failure. The mainnet onboarding crash was a tx that DID
 * confirm on-chain, yet viem's default ~60s wait expired first and threw — which
 * aborted the wizard before the keystore was persisted. Here we use a generous
 * timeout and, on timeout, re-poll `eth_getTransactionReceipt` directly before
 * giving up, so a slow-but-successful tx is reported as success.
 */
export async function waitForReceiptResilient(
  publicClient: PublicClient,
  hash: Hash,
  opts: { timeoutMs?: number; log?: (line: string) => void } = {},
): Promise<TransactionReceipt> {
  const timeout = opts.timeoutMs ?? DEFAULT_TX_TIMEOUT_MS
  const log = opts.log ?? (() => {})
  try {
    return await publicClient.waitForTransactionReceipt({ hash, timeout, confirmations: 1 })
  } catch (err) {
    if (!(err instanceof WaitForTransactionReceiptTimeoutError)) throw err
    log(`  ⏳ receipt wait timed out; re-checking ${hash} directly…`)
    for (let i = 0; i < 10; i++) {
      try {
        return await publicClient.getTransactionReceipt({ hash })
      } catch {
        // Not mined yet — TransactionReceiptNotFoundError. Keep polling.
      }
      await sleep(6000)
    }
    throw new Error(
      `Transaction ${hash} was submitted but not confirmed in time. It may still be ` +
        `pending — check a block explorer, and once it lands re-run with --resume ` +
        `(nothing is lost: the bot key is already saved).`,
    )
  }
}

/** True if the address currently has contract bytecode on-chain. */
export async function hasCode(
  publicClient: PublicClient,
  address: `0x${string}`,
): Promise<boolean> {
  const code = await publicClient.getCode({ address })
  return !!code && code !== '0x'
}
