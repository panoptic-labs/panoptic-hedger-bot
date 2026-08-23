import { randomUUID } from 'node:crypto'

import type { Address, Hex, PublicClient } from 'viem'
import { getAddress, isHex, TransactionReceiptNotFoundError } from 'viem'
import { z } from 'zod'

import type { HedgeAction } from '../executor/types'
import { botLog, botWarn } from '../utils/log'
import { runtimeDataPath } from './paths'
import { readSecureJson, writeSecureJson } from './secureFile'

export type HedgeJournalAction =
  | Exclude<HedgeAction, 'none'>
  | 'collateral_swap'
  | 'sfpm_swap'
  | 'wallet_redeposit'

const addressSchema = z.string().regex(/^0x[0-9a-fA-F]{40}$/)
const hexSchema = z.string().regex(/^0x[0-9a-f]+$/)
const tokenIdSchema = z.string().regex(/^\d+$/)
const journalIntentSchema = z
  .object({
    id: z.string().uuid(),
    createdAt: z.string().datetime(),
    action: z.enum([
      'open',
      'close_all',
      'grow',
      'shrink',
      'flip',
      'consolidate',
      'deleverage_loans',
      'deleverage_options',
      'collateral_swap',
      'sfpm_swap',
      'wallet_redeposit',
    ]),
    sender: addressSchema.nullable(),
    nonce: z.number().int().nonnegative().nullable(),
    target: addressSchema.nullable(),
    calldataHash: z
      .string()
      .regex(/^0x[0-9a-f]{64}$/)
      .nullable(),
    submittedAtBlock: tokenIdSchema.nullable(),
    broadcastAttempts: z.number().int().nonnegative(),
    hashes: hexSchema.array().max(32),
    status: z.enum(['pending', 'confirmed']),
    confirmedHash: z
      .string()
      .regex(/^0x[0-9a-f]{64}$/)
      .nullable(),
    blockNumber: tokenIdSchema.nullable(),
    blockHash: z
      .string()
      .regex(/^0x[0-9a-f]{64}$/)
      .nullable(),
  })
  .strict()

const journalSchema = z
  .object({
    version: z.literal(3),
    chainId: z.number().int().positive(),
    safe: addressSchema,
    pool: addressSchema,
    signer: addressSchema,
    intents: journalIntentSchema.array().max(256),
  })
  .strict()

const v2IntentSchema = journalIntentSchema.omit({ broadcastAttempts: true })
const v2JournalSchema = z
  .object({
    version: z.literal(2),
    chainId: z.number().int().positive(),
    safe: addressSchema,
    pool: addressSchema,
    signer: addressSchema,
    intents: v2IntentSchema.array().max(256),
  })
  .strict()
const legacyIntentSchema = v2IntentSchema.extend({
  expectedOpened: tokenIdSchema.nullable(),
  expectedClosed: tokenIdSchema.array().max(64),
  openPositionSize: tokenIdSchema.nullable(),
  currentTick: z.string().regex(/^-?\d+$/),
  slippageBps: tokenIdSchema,
  status: z.enum(['pending', 'confirmed', 'failed']),
})
const legacyJournalSchema = z
  .object({
    version: z.literal(1),
    chainId: z.number().int().positive(),
    safe: addressSchema,
    pool: addressSchema,
    signer: addressSchema,
    ownedTokenIds: tokenIdSchema.array().max(128),
    intents: legacyIntentSchema.array().max(256),
  })
  .strict()
const journalFileSchema = z.union([journalSchema, v2JournalSchema, legacyJournalSchema])

type JournalData = z.infer<typeof journalSchema>

function migrateV2Intent(entry: z.infer<typeof v2IntentSchema>) {
  return {
    ...entry,
    // v2 only persisted transaction identity after sendTransaction returned,
    // so any identified transaction must be treated as already attempted.
    broadcastAttempts: entry.submittedAtBlock === null ? 0 : 1,
  }
}

export interface JournalTransactionUpdate {
  sender: Address
  nonce: number
  target: Address
  calldataHash: Hex
  submittedAtBlock: bigint
  hashes: readonly Hex[]
}

export interface HedgeJournalCheckpoint {
  intentId?: string
  action?: HedgeJournalAction
  transactionHash?: Hex
  fromBlock?: bigint
}

export interface HedgeRecoveryClient {
  getBlockNumber(): Promise<bigint>
  getBlock(args: { blockNumber: bigint }): Promise<{ hash: Hex | null }>
  getTransactionReceipt(args: { hash: Hex }): Promise<{
    transactionHash: Hex
    blockNumber: bigint
    blockHash: Hex
    from: Address
    to: Address | null
    status: 'success' | 'reverted'
  }>
  getTransactionCount(address: Address): Promise<number>
}

export function createHedgeRecoveryClient(publicClient: PublicClient): HedgeRecoveryClient {
  return {
    getBlockNumber: () => publicClient.getBlockNumber(),
    getBlock: (args) => publicClient.getBlock(args),
    getTransactionReceipt: (args) => publicClient.getTransactionReceipt(args),
    getTransactionCount: (address) =>
      publicClient.getTransactionCount({ address, blockTag: 'latest' }),
  }
}

export interface HedgeJournalPort {
  begin(action: HedgeJournalAction): string
  observeTransaction(update: JournalTransactionUpdate): void
  recordBroadcastAttempt(): void
  confirm(receipt: { transactionHash: Hex; blockNumber: bigint; blockHash: Hex }): void
  fail(): void
  recover(publicClient: HedgeRecoveryClient): Promise<void>
  checkpoint(): HedgeJournalCheckpoint
}

function lower(address: Address): Address {
  return getAddress(address)
}

function checkedHex(value: string): Hex {
  if (!isHex(value)) throw new Error('invalid hex value in hedge journal')
  return value
}

export function hedgeJournalPath(): string {
  return process.env.HEDGER_JOURNAL_PATH ?? runtimeDataPath('.hedger-journal.json')
}

export class HedgeJournal implements HedgeJournalPort {
  private data: JournalData
  private activeIntentId: string | null = null
  private readonly confirmedRecheckBlocks: bigint
  private readonly nonceStallBlocks: bigint

  constructor(
    identity: { chainId: number; safe: Address; pool: Address; signer: Address },
    options: { confirmedRecheckBlocks?: bigint; nonceStallBlocks?: bigint } = {},
  ) {
    this.confirmedRecheckBlocks = options.confirmedRecheckBlocks ?? 64n
    this.nonceStallBlocks = options.nonceStallBlocks ?? 64n
    const existing = readSecureJson(hedgeJournalPath(), journalFileSchema, {
      maxBytes: 256 * 1024,
      invalid: 'throw',
    })
    if (existing === null) {
      this.data = {
        version: 3,
        chainId: identity.chainId,
        safe: lower(identity.safe),
        pool: lower(identity.pool),
        signer: lower(identity.signer),
        intents: [],
      }
      return
    }
    const parsed: JournalData = {
      version: 3,
      chainId: existing.chainId,
      safe: existing.safe,
      pool: existing.pool,
      signer: existing.signer,
      intents: (() => {
        if (existing.version === 3) return existing.intents
        if (existing.version === 2) return existing.intents.map(migrateV2Intent)
        return existing.intents
          .filter((entry) => entry.status !== 'failed')
          .map(
            ({
              expectedOpened: _expectedOpened,
              expectedClosed: _expectedClosed,
              openPositionSize: _openPositionSize,
              currentTick: _currentTick,
              slippageBps: _slippageBps,
              ...entry
            }) => migrateV2Intent({ ...entry, status: entry.status as 'pending' | 'confirmed' }),
          )
      })(),
    }
    if (
      parsed.chainId !== identity.chainId ||
      parsed.safe !== lower(identity.safe) ||
      parsed.pool !== lower(identity.pool) ||
      parsed.signer !== lower(identity.signer)
    ) {
      throw new Error('hedge journal identity does not match signer/Safe/pool configuration')
    }
    this.data = parsed
  }

  begin(action: HedgeJournalAction): string {
    if (this.data.intents.some((entry) => entry.status === 'pending')) {
      throw new Error('ambiguous pending hedge intent must be recovered before planning')
    }
    const entry: z.infer<typeof journalIntentSchema> = {
      id: randomUUID(),
      createdAt: new Date().toISOString(),
      action,
      sender: null,
      nonce: null,
      target: null,
      calldataHash: null,
      submittedAtBlock: null,
      broadcastAttempts: 0,
      hashes: [],
      status: 'pending',
      confirmedHash: null,
      blockNumber: null,
      blockHash: null,
    }
    this.data.intents.push(entry)
    this.activeIntentId = entry.id
    this.persist()
    return entry.id
  }

  observeTransaction(update: JournalTransactionUpdate): void {
    const entry = this.activeIntent()
    const immutable = {
      sender: lower(update.sender),
      nonce: update.nonce,
      target: lower(update.target),
      calldataHash: update.calldataHash.toLowerCase(),
      submittedAtBlock: update.submittedAtBlock.toString(),
    }
    if (entry.sender !== null) {
      if (
        entry.sender !== immutable.sender ||
        entry.nonce !== immutable.nonce ||
        entry.target !== immutable.target ||
        entry.calldataHash !== immutable.calldataHash ||
        entry.submittedAtBlock !== immutable.submittedAtBlock
      ) {
        throw new Error('replacement changed sender, nonce, target, or calldata identity')
      }
    } else {
      Object.assign(entry, immutable)
    }
    entry.hashes = [...new Set(update.hashes.map((hash) => hash.toLowerCase()))]
    this.persist()
  }

  recordBroadcastAttempt(): void {
    const entry = this.activeIntent()
    if (
      entry.sender === null ||
      entry.nonce === null ||
      entry.target === null ||
      entry.calldataHash === null ||
      entry.submittedAtBlock === null
    ) {
      throw new Error('transaction identity must be durable before broadcast')
    }
    entry.broadcastAttempts += 1
    this.persist()
  }

  confirm(receipt: { transactionHash: Hex; blockNumber: bigint; blockHash: Hex }): void {
    const entry = this.activeIntent()
    const transactionHash = receipt.transactionHash.toLowerCase()
    if (!entry.hashes.includes(transactionHash)) {
      throw new Error('confirmed transaction is not an observed hedge replacement')
    }
    entry.status = 'confirmed'
    entry.confirmedHash = transactionHash
    entry.blockNumber = receipt.blockNumber.toString()
    entry.blockHash = receipt.blockHash.toLowerCase()
    this.activeIntentId = null
    this.pruneTerminalIntents(receipt.blockNumber)
    this.persist()
  }

  fail(): void {
    const entry = this.activeIntent()
    this.data.intents = this.data.intents.filter((candidate) => candidate.id !== entry.id)
    this.activeIntentId = null
    this.persist()
  }

  async recover(publicClient: HedgeRecoveryClient): Promise<void> {
    const latestBlock = await publicClient.getBlockNumber()
    for (const entry of [...this.data.intents]) {
      if (entry.status === 'confirmed') {
        if (
          entry.blockNumber === null ||
          entry.blockHash === null ||
          entry.confirmedHash === null
        ) {
          throw new Error('confirmed hedge journal entry is incomplete')
        }
        const confirmedAt = BigInt(entry.blockNumber)
        if (latestBlock >= confirmedAt && latestBlock - confirmedAt > this.confirmedRecheckBlocks) {
          continue
        }
        const block = await publicClient.getBlock({ blockNumber: confirmedAt })
        if (block.hash === null || block.hash.toLowerCase() !== entry.blockHash) {
          throw new Error('confirmed hedge transaction was reorganized; operator review required')
        }
        const receipt = await publicClient.getTransactionReceipt({
          hash: checkedHex(entry.confirmedHash),
        })
        if (
          receipt.status !== 'success' ||
          receipt.blockHash.toLowerCase() !== entry.blockHash ||
          receipt.blockNumber.toString() !== entry.blockNumber
        ) {
          throw new Error('confirmed hedge receipt no longer matches its durable checkpoint')
        }
        continue
      }
      if (entry.status !== 'pending') continue

      // Fast path: any recorded replacement hash whose receipt we can fetch
      // resolves recovery directly. Prefer a success; a lone revert also settles
      // the entry. Multiple mined replacements at once are treated as "spent" —
      // exactly which one landed is not load-bearing because the next cycle
      // re-derives the plan from live on-chain state.
      const receipts = await Promise.all(
        entry.hashes.map((hash) => {
          if (!isHex(hash)) throw new Error('invalid transaction hash in hedge journal')
          // Only "not found" (tx still unknown to this node) means "no receipt";
          // transport/RPC failures must propagate so recovery does not silently
          // treat an unreachable node as evidence the tx never landed.
          return publicClient.getTransactionReceipt({ hash }).catch((error) => {
            if (error instanceof TransactionReceiptNotFoundError) return null
            throw error
          })
        }),
      )
      const mined = receipts.filter((receipt) => receipt !== null)
      const success = mined.find((receipt) => receipt.status === 'success')
      if (success) {
        if (
          entry.sender === null ||
          entry.nonce === null ||
          entry.target === null ||
          getAddress(success.from) !== entry.sender ||
          (success.to === null ? null : getAddress(success.to)) !== entry.target
        ) {
          throw new Error('mined replacement does not match the durable hedge transaction identity')
        }
        entry.hashes = [...new Set([...entry.hashes, success.transactionHash.toLowerCase()])]
        this.activeIntentId = entry.id
        this.confirm({
          transactionHash: success.transactionHash,
          blockNumber: success.blockNumber,
          blockHash: success.blockHash,
        })
        continue
      }
      if (mined.length > 0) {
        botWarn(
          `[hedger-bot] pending intent ${entry.id} (action=${entry.action}) all recorded ` +
            `replacements reverted; dropping so the next cycle can re-plan from chain state`,
        )
        this.activeIntentId = entry.id
        this.fail()
        continue
      }

      // No receipt for any recorded hash. Use the sender's on-chain nonce as the
      // deterministic ground truth: if the nonce slot is spent, something landed
      // (a fee-bumped replacement, or an out-of-band tx). We don't need to know
      // exactly what — the next cycle re-derives the plan from chain state, so
      // the effect (or lack of it) is already visible. Drop the entry.
      if (entry.broadcastAttempts === 0 || entry.sender === null || entry.nonce === null) {
        botLog(
          `[hedger-bot] auto-expiring never-broadcast intent ${entry.id} (action=${entry.action})`,
        )
        this.activeIntentId = entry.id
        this.fail()
        continue
      }
      const chainNonce = await publicClient.getTransactionCount(getAddress(entry.sender))
      if (chainNonce > entry.nonce) {
        botWarn(
          `[hedger-bot] pending intent ${entry.id} (action=${entry.action}, nonce=${entry.nonce}) ` +
            `is spent on-chain (chainNonce=${chainNonce}); dropping — the next cycle re-derives ` +
            `from chain state. Correlate on Etherscan if you need the exact hash.`,
        )
        this.activeIntentId = entry.id
        this.fail()
        continue
      }
      const submittedAt =
        entry.submittedAtBlock === null ? latestBlock : BigInt(entry.submittedAtBlock)
      const blocksSinceSubmit = latestBlock > submittedAt ? latestBlock - submittedAt : 0n
      if (blocksSinceSubmit < this.nonceStallBlocks) {
        // Nonce slot still open and it's too early to declare the send lost.
        // Keep the entry pending; next cycle's begin() will bounce and recovery
        // will retry when the wait exceeds the stall window.
        botLog(
          `[hedger-bot] pending intent ${entry.id} (action=${entry.action}, nonce=${entry.nonce}) ` +
            `still legitimately in flight (chainNonce=${chainNonce}, blocksSinceSubmit=` +
            `${blocksSinceSubmit}); keeping pending`,
        )
        continue
      }
      botWarn(
        `[hedger-bot] pending intent ${entry.id} (action=${entry.action}, nonce=${entry.nonce}) ` +
          `and all fee-bumped replacements dropped from mempool ` +
          `(chainNonce=${chainNonce}, blocksSinceSubmit=${blocksSinceSubmit}); auto-failing`,
      )
      this.activeIntentId = entry.id
      this.fail()
    }
    this.pruneTerminalIntents(latestBlock)
    this.persist()
  }

  checkpoint(): HedgeJournalCheckpoint {
    for (let index = this.data.intents.length - 1; index >= 0; index--) {
      const entry = this.data.intents[index]
      if (entry.status === 'confirmed' && entry.confirmedHash !== null) {
        return {
          intentId: entry.id,
          action: entry.action,
          transactionHash: checkedHex(entry.confirmedHash),
          fromBlock: entry.submittedAtBlock === null ? undefined : BigInt(entry.submittedAtBlock),
        }
      }
    }
    return {}
  }

  private activeIntent() {
    const id = this.activeIntentId
    const entry = id ? this.data.intents.find((candidate) => candidate.id === id) : undefined
    if (!entry) throw new Error('transaction send attempted without an active durable hedge intent')
    return entry
  }

  private pruneTerminalIntents(latestBlock: bigint): void {
    let latestConfirmedId: string | undefined
    for (const entry of this.data.intents) {
      if (entry.status === 'confirmed' && entry.confirmedHash !== null) {
        latestConfirmedId = entry.id
      }
    }
    this.data.intents = this.data.intents.filter((entry) => {
      if (entry.status === 'pending') return true
      if (entry.id === latestConfirmedId) return true
      if (entry.blockNumber === null) return true
      const blockNumber = BigInt(entry.blockNumber)
      return latestBlock < blockNumber || latestBlock - blockNumber <= this.confirmedRecheckBlocks
    })
  }

  private persist(): void {
    this.data = journalSchema.parse(this.data)
    writeSecureJson(hedgeJournalPath(), journalSchema, this.data)
  }
}
