import type { Address, Hex, PublicClient } from 'viem'
import {
  concatHex,
  encodeFunctionData,
  getAddress,
  isAddressEqual,
  isHex,
  size,
  zeroAddress,
} from 'viem'
import { z } from 'zod'

import type { GasPolicy } from '../gas/gasPolicy'
import type { HedgeJournalPort } from '../runtime/hedgeJournal'
import { sanitizeError } from '../utils/sanitize'
import type { KeeperSender } from './keeperSender'

/**
 * Executes Safe transactions that owners signed off-chain (Safe{Wallet} "Sign",
 * queued in the Safe Transaction Service), so owners never spend gas. The
 * service is untrusted: owners, threshold and nonce are read on-chain, and the
 * Safe itself verifies every signature in a pre-send simulation.
 */

export const safeExecTransactionAbi = [
  {
    type: 'function',
    name: 'execTransaction',
    stateMutability: 'payable',
    inputs: [
      { name: 'to', type: 'address' },
      { name: 'value', type: 'uint256' },
      { name: 'data', type: 'bytes' },
      { name: 'operation', type: 'uint8' },
      { name: 'safeTxGas', type: 'uint256' },
      { name: 'baseGas', type: 'uint256' },
      { name: 'gasPrice', type: 'uint256' },
      { name: 'gasToken', type: 'address' },
      { name: 'refundReceiver', type: 'address' },
      { name: 'signatures', type: 'bytes' },
    ],
    outputs: [{ name: 'success', type: 'bool' }],
  },
  {
    type: 'function',
    name: 'nonce',
    stateMutability: 'view',
    inputs: [],
    outputs: [{ type: 'uint256' }],
  },
  {
    type: 'function',
    name: 'getThreshold',
    stateMutability: 'view',
    inputs: [],
    outputs: [{ type: 'uint256' }],
  },
  {
    type: 'function',
    name: 'getOwners',
    stateMutability: 'view',
    inputs: [],
    outputs: [{ type: 'address[]' }],
  },
] as const

/** Upper bound on keeper gas for one relayed owner transaction. */
export const MAX_RELAY_GAS = 3_000_000n

// Safe selectors that hand an address control: addOwnerWithThreshold, swapOwner, enableModule.
const CONTROL_GRANT_SELECTORS = ['0d582f13', 'e318b52b', '610b5925'] as const

const hexSchema = z.string().refine((value): value is Hex => isHex(value), 'must be hex')
const uintSchema = z.string().regex(/^\d+$/)
const addressSchema = z.string().regex(/^0x[0-9a-fA-F]{40}$/)

const confirmationSchema = z.object({
  owner: addressSchema,
  signature: hexSchema.nullable(),
  signatureType: z.string(),
})

const multisigTransactionSchema = z.object({
  safe: addressSchema,
  to: addressSchema,
  value: uintSchema,
  data: hexSchema.nullable(),
  operation: z.union([z.literal(0), z.literal(1)]),
  safeTxGas: uintSchema,
  baseGas: uintSchema,
  gasPrice: uintSchema,
  gasToken: addressSchema,
  refundReceiver: addressSchema,
  nonce: uintSchema,
  safeTxHash: hexSchema.refine((value) => /^0x[0-9a-fA-F]{64}$/.test(value), 'must be 32 bytes'),
  isExecuted: z.boolean(),
  confirmations: confirmationSchema.array().nullable(),
})

const multisigTransactionPageSchema = z.object({
  results: z.array(z.unknown()),
})

/** Stable skip category; `reason` carries the volatile detail. */
export type SafeRelaySkipCode = 'conflict' | 'refused' | 'simulation' | 'gas-cap'

export type SafeRelayOutcome =
  | { kind: 'idle' }
  | { kind: 'skipped'; safeTxHash?: Hex; code: SafeRelaySkipCode; reason: string }
  | { kind: 'deferred'; safeTxHash: Hex; reason: string; shouldNotify: boolean }
  | { kind: 'simulated'; safeTxHash: Hex; nonce: bigint }
  | { kind: 'executed'; safeTxHash: Hex; nonce: bigint; transactionHash: Hex }

export interface SignedSafeTxRelay {
  /**
   * Execute the fully-signed queued transaction at the Safe's current nonce,
   * if exactly one exists. In dry-run it is simulated but never sent. Throws on
   * a reverted or unconfirmed send; TxNotMinedError leaves the journal intent
   * pending for the hedger's recovery path.
   */
  relayNext(): Promise<SafeRelayOutcome>
}

export interface SignedSafeTxRelayDeps {
  publicClient: PublicClient
  sender: KeeperSender
  gasPolicy: Pick<GasPolicy, 'assess'>
  hedgeJournal: Pick<HedgeJournalPort, 'begin' | 'confirm' | 'fail'>
  fetch: typeof fetch
  serviceUrl: string
  safeAddress: Address
  botAddress: Address
  dryRun: boolean
}

type MultisigTransaction = z.infer<typeof multisigTransactionSchema>

interface ReadyTransaction {
  safeTxHash: Hex
  nonce: bigint
  calldata: Hex
}

/**
 * Pack owner signatures the way `checkNSignatures` requires: exactly
 * `threshold` 65-byte entries, owners strictly ascending. Returns null when the
 * current owners have not produced enough supported signatures.
 */
export function packThresholdSignatures(
  confirmations: readonly z.infer<typeof confirmationSchema>[],
  owners: readonly Address[],
  threshold: bigint,
): Hex | null {
  const usable = new Map<bigint, Hex>()
  for (const confirmation of confirmations) {
    const signature = confirmation.signature
    if (signature === null || size(signature) !== 65) continue
    if (!owners.some((owner) => isAddressEqual(owner, getAddress(confirmation.owner)))) continue
    const v = Number.parseInt(signature.slice(-2), 16)
    // v 0 is a contract signature whose dynamic payload cannot be packed here.
    if (v === 0) continue
    usable.set(BigInt(confirmation.owner), signature)
  }
  if (threshold <= 0n || BigInt(usable.size) < threshold) return null
  const ordered = [...usable.entries()].sort(([a], [b]) => (a < b ? -1 : 1))
  return concatHex(ordered.slice(0, Number(threshold)).map(([, signature]) => signature))
}

/** Relayed owner intents must never make the bot an owner or module of the Safe. */
export function grantsBotControl(data: Hex, botAddress: Address): boolean {
  const body = data.toLowerCase()
  const bot = getAddress(botAddress).slice(2).toLowerCase().padStart(64, '0')
  return body.includes(bot) && CONTROL_GRANT_SELECTORS.some((selector) => body.includes(selector))
}

export function createSignedSafeTxRelay(deps: SignedSafeTxRelayDeps): SignedSafeTxRelay {
  const safeAddress = getAddress(deps.safeAddress)

  async function readSafeState() {
    const contract = { address: safeAddress, abi: safeExecTransactionAbi } as const
    const [nonce, threshold, owners] = await Promise.all([
      deps.publicClient.readContract({ ...contract, functionName: 'nonce' }),
      deps.publicClient.readContract({ ...contract, functionName: 'getThreshold' }),
      deps.publicClient.readContract({ ...contract, functionName: 'getOwners' }),
    ])
    return { nonce, threshold, owners }
  }

  async function fetchQueued(nonce: bigint): Promise<MultisigTransaction[]> {
    const url =
      `${deps.serviceUrl}/api/v2/safes/${safeAddress}/multisig-transactions/` +
      `?executed=false&nonce=${nonce}&limit=20`
    const response = await deps.fetch(url, { signal: AbortSignal.timeout(10_000) })
    if (!response.ok) {
      throw new Error(`Safe Transaction Service responded ${response.status}`)
    }
    const page = multisigTransactionPageSchema.parse(await response.json())
    return page.results.flatMap((raw) => {
      const parsed = multisigTransactionSchema.safeParse(raw)
      return parsed.success ? [parsed.data] : []
    })
  }

  function encodeExec(tx: MultisigTransaction, signatures: Hex): Hex {
    return encodeFunctionData({
      abi: safeExecTransactionAbi,
      functionName: 'execTransaction',
      args: [
        getAddress(tx.to),
        BigInt(tx.value),
        tx.data ?? '0x',
        tx.operation,
        BigInt(tx.safeTxGas),
        BigInt(tx.baseGas),
        BigInt(tx.gasPrice),
        getAddress(tx.gasToken),
        getAddress(tx.refundReceiver),
        signatures,
      ],
    })
  }

  /** Reason the keeper refuses to pay for this owner intent, or null. */
  function refusal(tx: MultisigTransaction): string | null {
    if (BigInt(tx.gasPrice) !== 0n || !isAddressEqual(getAddress(tx.gasToken), zeroAddress)) {
      return 'requests a Safe gas refund; the keeper relays only gasPrice=0 transactions'
    }
    // With safeTxGas=0 an inner failure reverts execTransaction, so a mined
    // relay always means the owner intent succeeded.
    if (BigInt(tx.safeTxGas) !== 0n) return 'sets safeTxGas; only safeTxGas=0 is relayed'
    if (grantsBotControl(tx.data ?? '0x', deps.botAddress)) {
      return 'would make the keeper a Safe owner or module'
    }
    return null
  }

  async function selectReady(): Promise<ReadyTransaction | SafeRelayOutcome> {
    const { nonce, threshold, owners } = await readSafeState()
    const queued = (await fetchQueued(nonce)).filter(
      (tx) =>
        !tx.isExecuted &&
        BigInt(tx.nonce) === nonce &&
        isAddressEqual(getAddress(tx.safe), safeAddress),
    )
    const signed = queued.flatMap((tx) => {
      const signatures = packThresholdSignatures(tx.confirmations ?? [], owners, threshold)
      return signatures === null ? [] : [{ tx, signatures }]
    })
    if (signed.length === 0) return { kind: 'idle' }
    if (signed.length > 1) {
      return {
        kind: 'skipped',
        code: 'conflict',
        reason: `${signed.length} fully-signed transactions compete for nonce ${nonce}`,
      }
    }
    const [{ tx, signatures }] = signed
    const safeTxHash = tx.safeTxHash
    const refused = refusal(tx)
    if (refused) return { kind: 'skipped', safeTxHash, code: 'refused', reason: refused }
    return { safeTxHash, nonce, calldata: encodeExec(tx, signatures) }
  }

  async function relayNext(): Promise<SafeRelayOutcome> {
    const selected = await selectReady()
    if ('kind' in selected) return selected
    const { safeTxHash, nonce, calldata } = selected

    const request = { account: deps.botAddress, to: safeAddress, data: calldata }
    let gas: bigint
    try {
      const simulation = await deps.publicClient.call(request)
      if (simulation.data === undefined || BigInt(simulation.data) !== 1n) {
        return {
          kind: 'skipped',
          safeTxHash,
          code: 'simulation',
          reason: 'Safe simulation did not return success',
        }
      }
      gas = await deps.publicClient.estimateGas(request)
    } catch (error) {
      return {
        kind: 'skipped',
        safeTxHash,
        code: 'simulation',
        reason: `simulation reverted: ${sanitizeError(error)}`,
      }
    }
    if (gas > MAX_RELAY_GAS) {
      return {
        kind: 'skipped',
        safeTxHash,
        code: 'gas-cap',
        reason: `needs ${gas} gas (cap ${MAX_RELAY_GAS})`,
      }
    }
    if (deps.dryRun) return { kind: 'simulated', safeTxHash, nonce }

    const assessment = await deps.gasPolicy.assess(false)
    if (!assessment.proceed) {
      return {
        kind: 'deferred',
        safeTxHash,
        reason: `basefee ${assessment.baseFeeGwei} gwei above ${assessment.capGwei} gwei cap`,
        shouldNotify: assessment.shouldNotifySkip,
      }
    }

    deps.hedgeJournal.begin('safe_relay')
    let receipt
    let broadcastAttempted = false
    try {
      receipt = await deps.sender.send(
        { to: safeAddress, data: calldata },
        {
          onBroadcastAttempt: () => {
            broadcastAttempted = true
          },
        },
      )
    } catch (error) {
      if (!broadcastAttempted) deps.hedgeJournal.fail()
      throw error
    }
    if (receipt.status !== 'success') {
      deps.hedgeJournal.fail()
      throw new Error(`relayed Safe transaction ${safeTxHash} reverted: ${receipt.transactionHash}`)
    }
    deps.hedgeJournal.confirm({
      transactionHash: receipt.transactionHash,
      blockNumber: receipt.blockNumber,
      blockHash: receipt.blockHash,
    })
    return { kind: 'executed', safeTxHash, nonce, transactionHash: receipt.transactionHash }
  }

  return { relayNext }
}
