import { isGasError, isNonceError } from '@panoptic-eng/sdk/v2'
import type {
  Account,
  Address,
  Chain,
  Hex,
  PublicClient,
  TransactionReceipt,
  WalletClient,
} from 'viem'
import { keccak256, TransactionReceiptNotFoundError } from 'viem'

import type { GasFees } from '../gas/gasPolicy'
import type { JournalTransactionUpdate } from '../runtime/hedgeJournal'
import { assertBotIsNotSafeOwner } from '../security/safeOwnerInvariant'
import { botWarn } from '../utils/log'
import { sanitizeError } from '../utils/sanitize'
import { sleep as defaultSleep } from '../utils/sleep'

type Fees = GasFees

export interface KeeperSenderDeps {
  publicClient: PublicClient
  walletClient: WalletClient
  account: Account
  /** The Safe the keeper serves; the bot must never be one of its owners. */
  safeAddress: Address
  chain?: Chain
  /**
   * Optional EIP-1559 fee-cap provider (see gas/gasPolicy.ts), applied to
   * every send. Returning undefined falls back to the wallet client's own
   * fee estimation (pre-1559 chains).
   */
  fees?: (opts?: { urgent?: boolean }) => Promise<Fees | undefined>
  /**
   * Replacement-fee provider for a stuck send (gasPolicy.bumped): elementwise
   * max(fresh estimate, ceil(prev x 1.25)). Returning null means the fee cap is
   * reached — stop bumping and wait out the remaining budget.
   */
  bumpFees?: (prev: Fees, opts?: { urgent?: boolean }) => Promise<Fees | null>
  /**
   * Enables confirm-with-escalation in `send`. The initial transaction gets two
   * mined blocks before its first replacement; subsequent replacement attempts
   * occur at most once per new block until the receipt deadline.
   */
  txWait?: { timeoutMs: number; pollIntervalMs?: number }
  /** Injectable clock/sleep for tests. */
  now?: () => number
  sleep?: (ms: number) => Promise<void>
  /** Durable write-ahead observer. A rejected write prevents transaction broadcast. */
  observeTransaction: (update: JournalTransactionUpdate) => void | Promise<void>
  /** Durable write-ahead marker recorded immediately before every broadcast attempt. */
  recordBroadcastAttempt: () => void | Promise<void>
  /** Resolves the latest marker when the RPC explicitly rejects that broadcast. */
  recordBroadcastRejection: () => void | Promise<void>
  /** Fencing/kill-switch assertion evaluated immediately before every broadcast. */
  assertSendAllowed: () => void | Promise<void>
}

/** A transaction the keeper EOA sends and pays gas for. */
export interface KeeperTransaction {
  to: Address
  data: Hex
}

export interface KeeperSendOptions {
  /** Called after a broadcast attempt is durably recorded, before sending. */
  onBroadcastAttempt?: () => void
  urgent?: boolean
  /** Maps a gas-estimation or first-broadcast failure to the thrown error. */
  onRejected?: (error: unknown) => Promise<never>
}

/**
 * A dispatch that never confirmed within the receipt budget, across every
 * fee-bumped replacement attempt. The message deliberately avoids the phrases
 * matched by the SDK's isNonceError ('nonce too low', 'already known', …) so
 * runCycle's transient-error suppression can never swallow the alert.
 */
export class TxNotMinedError extends Error {
  readonly hashes: Hex[]
  /** The most recent (highest-fee) attempt — the best guess at what may land. */
  readonly lastHash: Hex

  constructor(hashes: Hex[], timeoutMs: number) {
    const last = hashes[hashes.length - 1]
    super(
      `dispatch not mined within ${timeoutMs}ms after ${hashes.length} attempt(s) ` +
        `(last ${last}) — check the keeper's pending txs`,
    )
    this.name = 'TxNotMinedError'
    this.hashes = hashes
    this.lastHash = last
  }
}

export interface KeeperSender {
  /**
   * Send from the keeper EOA and wait for inclusion. The 1559 path pins the
   * nonce and fee-bumps it while stuck. Throws TxNotMinedError on budget
   * exhaustion. Inclusion is not success: callers still check receipt.status.
   */
  send(tx: KeeperTransaction, options?: KeeperSendOptions): Promise<TransactionReceipt>
}

const FIRST_REPLACEMENT_BLOCK_DELAY = 2n

function isExplicitBroadcastRejection(error: unknown): boolean {
  if (isGasError(error)) return true
  // "already known" proves that a hashless transaction may be live, so it must
  // remain ambiguous. The other nonce errors explicitly reject this attempt.
  return isNonceError(error) && !/already known/i.test(sanitizeError(error))
}

export function createKeeperSender(deps: KeeperSenderDeps): KeeperSender {
  const { publicClient, walletClient, account, safeAddress, chain } = deps
  const now = deps.now ?? Date.now
  const sleep = deps.sleep ?? defaultSleep

  async function recordBroadcastRejection(error: unknown): Promise<void> {
    if (isExplicitBroadcastRejection(error)) await deps.recordBroadcastRejection()
  }

  async function readEscalationBlock(): Promise<bigint | null> {
    try {
      return await publicClient.getBlockNumber()
    } catch (error) {
      botWarn(
        '[hedger-bot] escalation block lookup failed; continuing receipt wait: ' +
          sanitizeError(error),
      )
      return null
    }
  }

  /**
   * Poll receipts for every attempt (newest first — the highest-fee replacement
   * is the likeliest to have landed) until one is found or `windowMs` elapses.
   * Direct getTransactionReceipt polling: our replacements are self-sent hashes
   * we track ourselves, so viem's replacement detection isn't needed.
   */
  async function waitForAnyReceipt(
    hashes: Hex[],
    windowMs: number,
  ): Promise<TransactionReceipt | null> {
    const pollMs = deps.txWait?.pollIntervalMs ?? 4_000
    const deadline = now() + windowMs
    for (;;) {
      // One concurrent sweep per tick (the transport batches these); at most one
      // attempt can mine per nonce, so take the first receipt found — preferring
      // the newest (highest-fee) attempt on the off chance a flaky node reports
      // more than one. A failed lookup on one hash must not mask a receipt on
      // another, so collect settled results and check every hash first. Non-
      // "not found" errors (RPC outage, auth failure) still propagate — but only
      // once no receipt was found — rather than masquerade as "not mined".
      const sweep = await Promise.allSettled(
        hashes.map((hash) => publicClient.getTransactionReceipt({ hash })),
      )
      let sweepError: unknown
      for (let i = sweep.length - 1; i >= 0; i--) {
        const result = sweep[i]
        if (result.status === 'fulfilled') {
          if (result.value) return result.value
        } else if (!(result.reason instanceof TransactionReceiptNotFoundError)) {
          sweepError ??= result.reason
        }
      }
      if (sweepError !== undefined) throw sweepError
      const remaining = deadline - now()
      if (remaining <= 0) return null
      await sleep(remaining < pollMs ? remaining : pollMs)
    }
  }

  async function send(
    tx: KeeperTransaction,
    options: KeeperSendOptions = {},
  ): Promise<TransactionReceipt> {
    const { to, data } = tx
    const opts = { urgent: options.urgent }
    const rejectWith =
      options.onRejected ??
      ((err: unknown): Promise<never> => {
        throw err
      })
    await assertBotIsNotSafeOwner(publicClient, safeAddress, account.address)
    const [nonce, submittedAtBlock] = await Promise.all([
      publicClient.getTransactionCount({
        address: account.address,
        blockTag: 'pending',
      }),
      publicClient.getBlockNumber(),
    ])
    const hashes: Hex[] = []
    const observe = () =>
      deps.observeTransaction({
        sender: account.address,
        nonce,
        target: to,
        calldataHash: keccak256(data),
        submittedAtBlock,
        hashes: [...hashes],
      })
    const feeOverrides = await deps.fees?.(opts)
    const { bumpFees, txWait } = deps
    // Pre-1559 chains use a single send without replacement fee escalation.
    if (!feeOverrides || !bumpFees || !txWait) {
      await deps.assertSendAllowed()
      await observe()
      await deps.recordBroadcastAttempt()
      options.onBroadcastAttempt?.()
      try {
        const hash = await walletClient.sendTransaction({
          account,
          chain: chain ?? walletClient.chain ?? null,
          to,
          data,
          value: 0n,
          nonce,
          ...feeOverrides,
        })
        hashes.push(hash)
        await observe()
        if (txWait) {
          const receipt = await waitForAnyReceipt(hashes, txWait.timeoutMs)
          if (!receipt) throw new TxNotMinedError(hashes, txWait.timeoutMs)
          return receipt
        }
        return publicClient.waitForTransactionReceipt({ hash })
      } catch (err) {
        await recordBroadcastRejection(err)
        return rejectWith(err)
      }
    }

    // Confirm-with-escalation path. Pin the nonce (a plain local account has no
    // nonce manager — without this a "replacement" becomes a second queued tx)
    // and the gas limit (re-estimating mid-wait can revert on moved chain state
    // even though the pending original is fine; replacements differ only in fees).
    // A gas estimate on a reverting dispatch fails here, so enrich the revert
    // reason exactly like a failed send.
    let gas: bigint
    try {
      gas = await publicClient.estimateGas({
        account,
        to,
        data,
        value: 0n,
      })
    } catch (err) {
      return rejectWith(err)
    }
    const sendAttempt = async (fees: Fees) => {
      return walletClient.sendTransaction({
        account,
        chain: chain ?? walletClient.chain ?? null,
        to,
        data,
        value: 0n,
        nonce,
        gas,
        ...fees,
      })
    }

    let current = feeOverrides
    const startedAt = now()
    const deadline = startedAt + txWait.timeoutMs
    await deps.assertSendAllowed()
    await observe()
    await deps.recordBroadcastAttempt()
    options.onBroadcastAttempt?.()
    try {
      hashes.push(await sendAttempt(current))
      await observe()
    } catch (err) {
      await recordBroadcastRejection(err)
      // First send keeps the inner-revert decoding of the legacy path.
      return rejectWith(err)
    }

    // Anchor escalation to the head observed after the initial broadcast. This
    // guarantees that transaction two mined blocks of propagation/inclusion
    // opportunity even if estimation or signing crossed a block boundary.
    let lastEscalationBlock = await publicClient.getBlockNumber().catch((err) => {
      botWarn(
        '[hedger-bot] post-broadcast block lookup failed; using the pre-send block: ' +
          sanitizeError(err),
      )
      return submittedAtBlock
    })
    let nextBlockDelay = FIRST_REPLACEMENT_BLOCK_DELAY

    while (now() < deadline) {
      const targetBlock = lastEscalationBlock + nextBlockDelay
      let currentBlock = await readEscalationBlock()
      if (currentBlock === null) {
        const remaining = deadline - now()
        if (remaining <= 0) break
        const pollMs = txWait.pollIntervalMs ?? 4_000
        const receipt = await waitForAnyReceipt(hashes, remaining < pollMs ? remaining : pollMs)
        if (receipt) return receipt
        continue
      }
      while (currentBlock < targetBlock) {
        const remaining = deadline - now()
        if (remaining <= 0) break
        const pollMs = txWait.pollIntervalMs ?? 4_000
        const receipt = await waitForAnyReceipt(hashes, remaining < pollMs ? remaining : pollMs)
        if (receipt) return receipt
        currentBlock = (await readEscalationBlock()) ?? currentBlock
      }
      if (now() >= deadline) break

      // Count this as the block's escalation opportunity even when fee lookup
      // or broadcast fails. Retrying within the same block creates bursts and
      // cannot improve inclusion; the next attempt waits for the next head.
      lastEscalationBlock = currentBlock
      nextBlockDelay = 1n

      let next: Fees | null
      try {
        next = await bumpFees(current, opts)
      } catch (err) {
        // Transient failure estimating replacement fees (e.g. RPC hiccup in
        // getBlock): keep bumping enabled and retry on the next block.
        botWarn(
          '[hedger-bot] replacement fee estimation failed (will retry): ' + sanitizeError(err),
        )
        continue
      }
      if (next === null) {
        break // gasPolicy already emitted the immediate cap warning + notification
      }
      if (now() >= deadline) break
      await deps.assertSendAllowed()
      await deps.recordBroadcastAttempt()
      options.onBroadcastAttempt?.()
      try {
        hashes.push(await sendAttempt(next))
        await observe()
        current = next
      } catch (err) {
        await recordBroadcastRejection(err)
        if (isNonceError(err)) {
          // The nonce was consumed: almost certainly one of OUR attempts mined
          // between the poll and the re-send. Give receipts a short window.
          const left = deadline - now()
          const mined2 = await waitForAnyReceipt(hashes, left < 15_000 ? left : 15_000)
          if (mined2) return mined2
          // Same sanitization rule as TxNotMinedError: do NOT quote the raw
          // rejection (it contains the exact phrases isNonceError matches, and
          // runCycle would silently swallow the alert). Keep it on `cause`.
          const external = new Error(
            `dispatch replacement rejected but no attempt of ours mined — an external tx ` +
              `may have consumed the keeper's pending slot; check its recent txs`,
          )
          ;(external as { cause?: unknown }).cause = err
          throw external
        }
        if (isGasError(err)) {
          // 'replacement underpriced' etc.: the node wants more than our bump.
          // Ratchet `current` so the next bump climbs from the rejected level.
          current = next
        } else {
          botWarn(
            '[hedger-bot] fee-bump re-send failed (waiting on sent txs): ' + sanitizeError(err),
          )
        }
      }
    }

    const remaining = deadline - now()
    if (remaining > 0) {
      const mined = await waitForAnyReceipt(hashes, remaining)
      if (mined) return mined
    }
    const swept = await waitForAnyReceipt(hashes, 0)
    if (swept) return swept
    throw new TxNotMinedError(hashes, txWait.timeoutMs)
  }

  return { send }
}
