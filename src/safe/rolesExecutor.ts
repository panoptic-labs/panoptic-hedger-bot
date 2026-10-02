import { parsePanopticError } from '@panoptic-eng/sdk/v2'
import type { Address, Hex, TransactionReceipt } from 'viem'
import { encodeFunctionData, getAddress } from 'viem'

import { assertBotIsNotSafeOwner } from '../security/safeOwnerInvariant'
import { type KeeperSenderDeps, createKeeperSender } from './keeperSender'
import { rolesModifierV2Abi } from './rolesAbi'

export { TxNotMinedError } from './keeperSender'

/** A single call the bot wants the Safe to perform, relayed via the Roles modifier. */
export interface RolesCall {
  to: Address
  value: bigint
  data: Hex
  /** Zodiac Operation: 0 = Call (the only value the bot uses), 1 = DelegateCall. */
  operation: 0 | 1
}

export interface RolesExecutorDeps extends KeeperSenderDeps {
  /** The Zodiac Roles Modifier (v2) address. */
  rolesModifierAddress: Address
  /** bytes32 role key assigned to the bot EOA. */
  roleKey: Hex
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
  const { publicClient, account, rolesModifierAddress, roleKey, safeAddress } = deps
  const sender = createKeeperSender(deps)

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

  function send(call: RolesCall, opts?: { urgent?: boolean }): Promise<TransactionReceipt> {
    return sender.send(
      { to: rolesModifierAddress, data: wrapCalldata(call) },
      { urgent: opts?.urgent, onRejected: (err) => enrich(err, call) },
    )
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
