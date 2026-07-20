import { isGasError, isNonceError, parsePanopticError } from '@panoptic-eng/sdk/v2'
import type {
  Account,
  Address,
  Chain,
  Hex,
  PublicClient,
  TransactionReceipt,
  WalletClient,
} from 'viem'
import { encodeFunctionData, getAddress, keccak256, TransactionReceiptNotFoundError } from 'viem'

import type { GasFees } from '../gas/gasPolicy'
import type { JournalTransactionUpdate } from '../runtime/hedgeJournal'
import { assertBotIsNotSafeOwner } from '../security/safeOwnerInvariant'
import { botWarn } from '../utils/log'
import { sanitizeError } from '../utils/sanitize'
import { sleep as defaultSleep } from '../utils/sleep'
import { rolesModifierV2Abi } from './rolesAbi'

/** A single call the bot wants the Safe to perform, relayed via the Roles modifier. */
export interface RolesCall {
  to: Address
  value: bigint
  data: Hex
  /** Zodiac Operation: 0 = Call (the only value the bot uses), 1 = DelegateCall. */
  operation: 0 | 1
}

/** EIP-1559 fee pair (gas/gasPolicy.ts GasFees). */
type Fees = GasFees

export interface RolesExecutorDeps {
  publicClient: PublicClient
  walletClient: WalletClient
  account: Account
  /** The Zodiac Roles Modifier (v2) address. */
  rolesModifierAddress: Address
  /** bytes32 role key assigned to the bot EOA. */
  roleKey: Hex
  /** The Safe address the modifier fronts — asserted in preflight. */
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
   * max(fresh estimate, prev x 1.125). Returning null means the fee cap is
   * reached — stop bumping and wait out the remaining budget.
   */
  bumpFees?: (prev: Fees, opts?: { urgent?: boolean }) => Promise<Fees | null>
  /**
   * Enables confirm-with-escalation in `send`: wait `bumpIntervalMs` for a
   * receipt, then re-send the SAME nonce with bumped fees, within an overall
   * `timeoutMs` budget. Requires `fees` + `bumpFees`; without it (or on
   * pre-1559 chains) `send` is fire-and-forget as before.
   */
  txWait?: { timeoutMs: number; bumpIntervalMs: number; pollIntervalMs?: number }
  /** Injectable clock/sleep for tests. */
  now?: () => number
  sleep?: (ms: number) => Promise<void>
  /** Durable write-ahead observer. A rejected write prevents transaction broadcast. */
  observeTransaction: (update: JournalTransactionUpdate) => void | Promise<void>
  /** Fencing/kill-switch assertion evaluated immediately before every broadcast. */
  assertSendAllowed: () => void | Promise<void>
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

export interface RolesExecutor {
  /** Encode `execTransactionWithRole` calldata for a given call (pure). */
  wrapCalldata(call: RolesCall): Hex
  /**
   * Send the wrapped call as a transaction from the bot EOA. Both transaction
   * paths wait for inclusion and return a mined receipt; the 1559 path may
   * fee-bump the same nonce while stuck. Throws TxNotMinedError on configured
   * budget exhaustion. Inclusion is not success: callers still check receipt.status.
   */
  send(call: RolesCall, opts?: { urgent?: boolean }): Promise<TransactionReceipt>
  /**
   * `eth_call`-simulate the wrapped call from the bot EOA against the modifier.
   * Throws if it would revert (e.g. permission/scope violation). Used for
   * DRY_RUN and as an optional preflight of a representative call.
   */
  simulate(call: RolesCall): Promise<void>
  /**
   * Startup sanity checks that do not require internal Roles getters:
   * the modifier is deployed, and its avatar/target both point at the Safe.
   * Membership + scope are validated at runtime via `simulate`.
   */
  preflight(): Promise<void>
}

/**
 * We always request `shouldRevert = true` so a scope/permission failure bubbles
 * up as a revert we can catch and alert on, rather than silently returning
 * `success = false`.
 */
const SHOULD_REVERT = true

export function createRolesExecutor(deps: RolesExecutorDeps): RolesExecutor {
  const { publicClient, walletClient, account, rolesModifierAddress, roleKey, safeAddress, chain } =
    deps

  function wrapCalldata(call: RolesCall): Hex {
    return encodeFunctionData({
      abi: rolesModifierV2Abi,
      functionName: 'execTransactionWithRole',
      args: [call.to, call.value, call.data, call.operation, roleKey, SHOULD_REVERT],
    })
  }

  /**
   * The Roles modifier rewraps an inner revert as the opaque `ModuleTransactionFailed`,
   * hiding WHY the pool call failed. Re-run the inner call directly from the Safe
   * (msg.sender = Safe) so the real Panoptic custom error surfaces, and decode it.
   * Returns a human string like `PriceBoundFail(-201377)`, or null if it doesn't
   * reproduce (e.g. the failure was a role/scope violation, not a pool revert).
   */
  async function decodeInnerRevert(call: RolesCall): Promise<string | null> {
    try {
      await publicClient.call({
        account: safeAddress,
        to: call.to,
        data: call.data,
        value: call.value,
      })
      return null // inner call succeeds from the Safe ⇒ failure was role/scope-level
    } catch (err) {
      const parsed = parsePanopticError(err)
      if (!parsed) return null
      const args = parsed.args.length ? `(${parsed.args.map((a) => String(a)).join(', ')})` : ''
      return `${parsed.errorName}${args}`
    }
  }

  /** Wrap a viem revert with the decoded inner Panoptic reason, when available. */
  async function enrich(err: unknown, call: RolesCall): Promise<never> {
    const reason = await decodeInnerRevert(call).catch(() => null)
    if (reason) {
      const enriched = new Error(
        `dispatch reverted: ${reason} — the pool rejected the trade (e.g. price/tick ` +
          `limits, collateral, or size). Check the price signal + ASSET_INDEX match the pool.`,
      )
      ;(enriched as { cause?: unknown }).cause = err
      throw enriched
    }
    throw err
  }

  const now = deps.now ?? Date.now
  const sleep = deps.sleep ?? defaultSleep

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
      for (let i = hashes.length - 1; i >= 0; i--) {
        try {
          const receipt = await publicClient.getTransactionReceipt({ hash: hashes[i] })
          if (receipt) return receipt
        } catch (err) {
          // Not mined yet — keep polling. Anything else (RPC outage, auth
          // failure) must propagate rather than masquerade as "not mined".
          if (!(err instanceof TransactionReceiptNotFoundError)) throw err
        }
      }
      const remaining = deadline - now()
      if (remaining <= 0) return null
      await sleep(remaining < pollMs ? remaining : pollMs)
    }
  }

  async function send(call: RolesCall, opts?: { urgent?: boolean }): Promise<TransactionReceipt> {
    await assertBotIsNotSafeOwner(publicClient, safeAddress, account.address)
    const data = wrapCalldata(call)
    const nonce = await publicClient.getTransactionCount({
      address: account.address,
      blockTag: 'pending',
    })
    const submittedAtBlock = await publicClient.getBlockNumber()
    const hashes: Hex[] = []
    const observe = () =>
      deps.observeTransaction({
        sender: account.address,
        nonce,
        target: rolesModifierAddress,
        calldataHash: keccak256(data),
        submittedAtBlock,
        hashes,
      })
    const feeOverrides = await deps.fees?.(opts)
    const { bumpFees, txWait } = deps
    // Pre-1559 chains use a single send without replacement fee escalation.
    if (!feeOverrides || !bumpFees || !txWait) {
      await deps.assertSendAllowed()
      try {
        const hash = await walletClient.sendTransaction({
          account,
          chain: chain ?? walletClient.chain ?? null,
          to: rolesModifierAddress,
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
        return enrich(err, call)
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
        to: rolesModifierAddress,
        data,
        value: 0n,
      })
    } catch (err) {
      return enrich(err, call)
    }
    const sendAttempt = async (fees: Fees) => {
      return walletClient.sendTransaction({
        account,
        chain: chain ?? walletClient.chain ?? null,
        to: rolesModifierAddress,
        data,
        value: 0n,
        nonce,
        gas,
        ...fees,
      })
    }

    let current = feeOverrides
    let canBump = true
    const deadline = now() + txWait.timeoutMs
    await deps.assertSendAllowed()
    try {
      hashes.push(await sendAttempt(current))
      await observe()
    } catch (err) {
      // First send keeps the inner-revert decoding of the legacy path.
      return enrich(err, call)
    }

    for (;;) {
      const remaining = deadline - now()
      const window =
        canBump && txWait.bumpIntervalMs < remaining ? txWait.bumpIntervalMs : remaining
      const mined = await waitForAnyReceipt(hashes, window)
      if (mined) return mined
      if (now() >= deadline) {
        // One last sweep in case a receipt landed between the poll and now.
        const swept = await waitForAnyReceipt(hashes, 0)
        if (swept) return swept
        throw new TxNotMinedError(hashes, txWait.timeoutMs)
      }
      if (!canBump) continue
      let next: Fees | null
      try {
        next = await bumpFees(current, opts)
      } catch (err) {
        // Transient failure estimating replacement fees (e.g. RPC hiccup in
        // getBlock): keep bumping enabled and retry on the next window.
        botWarn(
          '[hedger-bot] replacement fee estimation failed (will retry): ' + sanitizeError(err),
        )
        continue
      }
      if (next === null) {
        canBump = false // fee cap reached — wait out the remaining budget
        continue
      }
      await deps.assertSendAllowed()
      try {
        hashes.push(await sendAttempt(next))
        await observe()
        current = next
      } catch (err) {
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
  }

  async function simulate(call: RolesCall): Promise<void> {
    // publicClient.call throws (with the revert reason) if the call reverts.
    try {
      await publicClient.call({
        account: account.address,
        to: rolesModifierAddress,
        data: wrapCalldata(call),
      })
    } catch (err) {
      await enrich(err, call)
    }
  }

  async function preflight(): Promise<void> {
    await assertBotIsNotSafeOwner(publicClient, safeAddress, account.address)
    const code = await publicClient.getCode({ address: rolesModifierAddress })
    if (!code || code === '0x') {
      throw new Error(
        `Roles modifier has no bytecode at ${rolesModifierAddress} — is it deployed on this chain?`,
      )
    }

    const [avatar, target] = await Promise.all([
      publicClient.readContract({
        address: rolesModifierAddress,
        abi: rolesModifierV2Abi,
        functionName: 'avatar',
      }),
      publicClient.readContract({
        address: rolesModifierAddress,
        abi: rolesModifierV2Abi,
        functionName: 'target',
      }),
    ])

    const expected = getAddress(safeAddress)
    if (getAddress(avatar) !== expected) {
      throw new Error(
        `Roles modifier avatar ${getAddress(avatar)} does not match configured Safe ${expected}`,
      )
    }
    if (getAddress(target) !== expected) {
      throw new Error(
        `Roles modifier target ${getAddress(target)} does not match configured Safe ${expected}`,
      )
    }
  }

  return { wrapCalldata, send, simulate, preflight }
}
