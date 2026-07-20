import { createTokenIdBuilder, panopticPoolV2Abi } from '@panoptic-eng/sdk/v2'
import { isPureLoanTokenId } from '@panoptic-eng/sdk/zodiac'
import type { PublicClient } from 'viem'
import { encodeFunctionData, toFunctionSelector } from 'viem'

import { MAX_TICK, MIN_TICK } from '../../src/constants/ticks'
import { rolesModifierV2Abi } from '../../src/safe/rolesAbi'
import { sanitizeError } from '../../src/utils/sanitize'

/**
 * Automate runbook Step 0 — the load-bearing security assertion: with the bot
 * EOA as caller, the Roles modifier must LET THROUGH a pure width=0 loan
 * `dispatch` and must BLOCK any `dispatch` carrying a width>0 (option) leg.
 *
 * A fresh Safe holds no collateral, so the loan `dispatch` legitimately reverts
 * *downstream* inside PanopticPool — that is fine (the scope let it through).
 * We therefore classify by revert LAYER, not by whether it reverts: only a
 * Roles-layer `ConditionViolation` counts as "blocked by scope".
 */

/**
 * Roles v2.1 scope-violation error: `ConditionViolation(Status status, bytes32 info)`
 * (Status is a uint8 enum). Its 4-byte selector is the signal that the Roles
 * modifier — not a downstream contract — rejected the call.
 */
const CONDITION_VIOLATION_SELECTOR = toFunctionSelector('ConditionViolation(uint8,bytes32)')

const SHOULD_REVERT = true
const OPERATION_CALL = 0

export interface VerifyScopeParams {
  publicClient: PublicClient
  rolesModifierAddress: `0x${string}`
  botAddress: `0x${string}`
  roleKey: `0x${string}`
  poolAddress: `0x${string}`
  /** Pool ID from getPoolMetadata — seeds the tokenId builder. */
  poolId: bigint
  log?: (line: string) => void
}

/** Build a minimal `dispatch(...)` calldata carrying a single tokenId in arg0. */
function buildDispatchData(tokenId: bigint): `0x${string}` {
  return encodeFunctionData({
    abi: panopticPoolV2Abi,
    functionName: 'dispatch',
    args: [
      [tokenId], // positionIdList — the arg the Roles ArrayEvery/Bitmask gate checks
      [tokenId], // finalPositionIdList (unconstrained by the scope)
      [1n], // positionSizes
      [[MIN_TICK, MAX_TICK, 0] as readonly [number, number, number]], // tickAndSpreadLimits
      false, // usePremiaAsCollateral
      0n, // builderCode
    ],
  })
}

/** Wrap a pool call in `execTransactionWithRole` calldata (shouldRevert=true). */
function wrapWithRole(
  poolAddress: `0x${string}`,
  roleKey: `0x${string}`,
  dispatchData: `0x${string}`,
): `0x${string}` {
  return encodeFunctionData({
    abi: rolesModifierV2Abi,
    functionName: 'execTransactionWithRole',
    args: [poolAddress, 0n, dispatchData, OPERATION_CALL, roleKey, SHOULD_REVERT],
  })
}

/** Best-effort extraction of raw revert bytes from a viem call error. */
function extractRevertData(err: unknown): `0x${string}` | undefined {
  const seen = new Set<unknown>()
  const stack: unknown[] = [err]
  while (stack.length > 0) {
    const node = stack.pop()
    if (!node || typeof node !== 'object' || seen.has(node)) continue
    seen.add(node)
    const rec = node as Record<string, unknown>
    const data = rec.data
    if (typeof data === 'string' && data.startsWith('0x') && data.length >= 10) {
      return data as `0x${string}`
    }
    if (
      data &&
      typeof data === 'object' &&
      typeof (data as Record<string, unknown>).data === 'string'
    ) {
      const inner = (data as Record<string, unknown>).data as string
      if (inner.startsWith('0x') && inner.length >= 10) return inner as `0x${string}`
    }
    for (const key of ['cause', 'error', 'walk']) {
      const child = rec[key]
      if (typeof child === 'function') continue
      if (child) stack.push(child)
    }
  }
  // Fallback: scan the serialized message for a ConditionViolation selector.
  const text = err instanceof Error ? `${err.message}\n${err.stack ?? ''}` : String(err)
  const match = text.match(/0x[0-9a-fA-F]{8,}/)
  return (match?.[0] as `0x${string}`) ?? undefined
}

function isConditionViolation(err: unknown): boolean {
  const data = extractRevertData(err)
  if (data?.toLowerCase().startsWith(CONDITION_VIOLATION_SELECTOR.toLowerCase())) return true
  // Fallback for RPCs that surface the decoded name rather than raw bytes.
  const text = err instanceof Error ? err.message : String(err)
  return /ConditionViolation/i.test(text)
}

/** eth_call the wrapped dispatch as the bot; return the caught error, or null if it did not revert. */
async function callAsBot(
  publicClient: PublicClient,
  rolesModifierAddress: `0x${string}`,
  botAddress: `0x${string}`,
  data: `0x${string}`,
): Promise<unknown | null> {
  try {
    await publicClient.call({ account: botAddress, to: rolesModifierAddress, data })
    return null
  } catch (err) {
    return err
  }
}

export async function verifyLoanOnlyScope(params: VerifyScopeParams): Promise<void> {
  const { publicClient, rolesModifierAddress, botAddress, roleKey, poolAddress, poolId } = params
  const log = params.log ?? console.log

  // Construct the two probe tokenIds and assert their classification up front,
  // so a builder change can't silently make the probes wrong.
  const loanTokenId = createTokenIdBuilder(poolId)
    .addLoan({ asset: 0n, tokenType: 0n, strike: 0n, optionRatio: 1n })
    .build()
  if (!isPureLoanTokenId(loanTokenId)) {
    throw new Error('verifyLoanOnlyScope: loan probe is not a pure loan tokenId (builder changed?)')
  }
  const optionTokenId = createTokenIdBuilder(poolId)
    .addCall({ strike: 0n, width: 10n, optionRatio: 1n, isLong: false })
    .build()
  if (isPureLoanTokenId(optionTokenId)) {
    throw new Error('verifyLoanOnlyScope: option probe is classified as a loan (builder changed?)')
  }

  // 1. Loan must NOT be blocked by the Roles scope (downstream revert is OK).
  const loanErr = await callAsBot(
    publicClient,
    rolesModifierAddress,
    botAddress,
    wrapWithRole(poolAddress, roleKey, buildDispatchData(loanTokenId)),
  )
  if (loanErr && isConditionViolation(loanErr)) {
    throw new Error(
      'Scope too STRICT: a pure width=0 loan dispatch was rejected by the Roles modifier ' +
        '(ConditionViolation). The loan bitmask is wrong — the bot cannot hedge.',
    )
  }
  log(
    loanErr
      ? '  ✓ loan dispatch passed the Roles gate (reverted downstream, as expected on an empty Safe)'
      : '  ✓ loan dispatch passed the Roles gate',
  )

  // 2. Option MUST be blocked by the Roles scope with a ConditionViolation.
  const optionErr = await callAsBot(
    publicClient,
    rolesModifierAddress,
    botAddress,
    wrapWithRole(poolAddress, roleKey, buildDispatchData(optionTokenId)),
  )
  if (!optionErr) {
    throw new Error(
      'Scope too LOOSE: a width>0 option dispatch was NOT reverted. The bot could touch ' +
        "the user's options — do NOT use this deployment.",
    )
  }
  if (!isConditionViolation(optionErr)) {
    throw new Error(
      'Scope check inconclusive: the option dispatch reverted, but NOT with a Roles ' +
        'ConditionViolation — it may have passed the scope gate and reverted downstream. ' +
        `Do NOT trust this deployment. Revert: ${sanitizeError(optionErr)}`,
    )
  }
  log('  ✓ option dispatch was blocked by the Roles modifier (ConditionViolation)')
}
