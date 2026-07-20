import { randomUUID } from 'node:crypto'

import type { Address, Hex, PublicClient } from 'viem'
import { getAddress, isHex, keccak256 } from 'viem'
import { z } from 'zod'

import type { HedgeAction } from '../executor/types'
import { runtimeDataPath } from './paths'
import { readSecureJson, writeSecureJson } from './secureFile'

const addressSchema = z.string().regex(/^0x[0-9a-fA-F]{40}$/)
const hexSchema = z.string().regex(/^0x[0-9a-f]+$/)
const tokenIdSchema = z.string().regex(/^\d+$/)
const journalIntentSchema = z
  .object({
    id: z.string().uuid(),
    createdAt: z.string().datetime(),
    action: z.enum(['open', 'close_all', 'grow', 'shrink', 'flip', 'consolidate']),
    sender: addressSchema.nullable(),
    nonce: z.number().int().nonnegative().nullable(),
    target: addressSchema.nullable(),
    calldataHash: z
      .string()
      .regex(/^0x[0-9a-f]{64}$/)
      .nullable(),
    submittedAtBlock: tokenIdSchema.nullable(),
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
    version: z.literal(2),
    chainId: z.number().int().positive(),
    safe: addressSchema,
    pool: addressSchema,
    signer: addressSchema,
    intents: journalIntentSchema.array().max(256),
  })
  .strict()

const legacyIntentSchema = journalIntentSchema.extend({
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
const journalFileSchema = z.union([journalSchema, legacyJournalSchema])

type JournalData = z.infer<typeof journalSchema>

export interface JournalTransactionUpdate {
  sender: Address
  nonce: number
  target: Address
  calldataHash: Hex
  submittedAtBlock: bigint
  hashes: readonly Hex[]
}

export interface HedgeJournalCheckpoint {
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
  findMinedTransactions(identity: {
    sender: Address
    nonce: number
    target: Address
    calldataHash: Hex
    fromBlock: bigint
  }): Promise<Hex[]>
}

const MAX_AMBIGUOUS_RECOVERY_BLOCKS = 2_048n

export function createHedgeRecoveryClient(publicClient: PublicClient): HedgeRecoveryClient {
  return {
    getBlockNumber: () => publicClient.getBlockNumber(),
    getBlock: (args) => publicClient.getBlock(args),
    getTransactionReceipt: (args) => publicClient.getTransactionReceipt(args),
    async findMinedTransactions(identity) {
      const latest = await publicClient.getBlockNumber()
      if (latest < identity.fromBlock) return []
      if (latest - identity.fromBlock > MAX_AMBIGUOUS_RECOVERY_BLOCKS) {
        throw new Error('ambiguous hedge recovery exceeds the bounded block search window')
      }
      const matches: Hex[] = []
      for (let blockNumber = identity.fromBlock; blockNumber <= latest; blockNumber += 1n) {
        const block = await publicClient.getBlock({ blockNumber, includeTransactions: true })
        for (const transaction of block.transactions) {
          if (
            typeof transaction !== 'string' &&
            getAddress(transaction.from) === getAddress(identity.sender) &&
            transaction.nonce === identity.nonce &&
            transaction.to !== null &&
            getAddress(transaction.to) === getAddress(identity.target) &&
            keccak256(transaction.input) === identity.calldataHash
          ) {
            matches.push(transaction.hash)
          }
        }
      }
      return matches
    },
  }
}

export interface HedgeJournalPort {
  begin(action: HedgeAction): void
  observeTransaction(update: JournalTransactionUpdate): void
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

  constructor(
    identity: { chainId: number; safe: Address; pool: Address; signer: Address },
    options: { confirmedRecheckBlocks?: bigint } = {},
  ) {
    this.confirmedRecheckBlocks = options.confirmedRecheckBlocks ?? 64n
    const existing = readSecureJson(hedgeJournalPath(), journalFileSchema, {
      maxBytes: 256 * 1024,
      invalid: 'throw',
    })
    if (existing === null) {
      this.data = {
        version: 2,
        chainId: identity.chainId,
        safe: lower(identity.safe),
        pool: lower(identity.pool),
        signer: lower(identity.signer),
        intents: [],
      }
      return
    }
    const parsed: JournalData =
      existing.version === 2
        ? existing
        : {
            version: 2,
            chainId: existing.chainId,
            safe: existing.safe,
            pool: existing.pool,
            signer: existing.signer,
            intents: existing.intents
              .filter((entry) => entry.status !== 'failed')
              .map(
                ({
                  expectedOpened: _expectedOpened,
                  expectedClosed: _expectedClosed,
                  openPositionSize: _openPositionSize,
                  currentTick: _currentTick,
                  slippageBps: _slippageBps,
                  ...entry
                }) => ({ ...entry, status: entry.status as 'pending' | 'confirmed' }),
              ),
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

  begin(action: HedgeAction): void {
    if (action === 'none') throw new Error('cannot journal a no-op hedge')
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
      hashes: [],
      status: 'pending',
      confirmedHash: null,
      blockNumber: null,
      blockHash: null,
    }
    this.data.intents.push(entry)
    this.activeIntentId = entry.id
    this.persist()
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
      if (
        entry.sender !== null &&
        entry.nonce !== null &&
        entry.target !== null &&
        entry.calldataHash !== null &&
        entry.submittedAtBlock !== null
      ) {
        const discovered = await publicClient.findMinedTransactions({
          sender: getAddress(entry.sender),
          nonce: entry.nonce,
          target: getAddress(entry.target),
          calldataHash: checkedHex(entry.calldataHash),
          fromBlock: BigInt(entry.submittedAtBlock),
        })
        entry.hashes = [
          ...new Set([...entry.hashes, ...discovered.map((hash) => hash.toLowerCase())]),
        ]
        if (discovered.length > 0) this.persist()
      }
      const receipts = await Promise.all(
        entry.hashes.map((hash) => {
          if (!isHex(hash)) throw new Error('invalid transaction hash in hedge journal')
          return publicClient.getTransactionReceipt({ hash }).catch(() => null)
        }),
      )
      const mined = receipts.filter((receipt) => receipt !== null)
      if (mined.length > 1) throw new Error('ambiguous hedge recovery: multiple replacements mined')
      const receipt = mined[0]
      if (!receipt)
        throw new Error('pending hedge has no confirmed replacement; operator review required')
      if (
        entry.sender === null ||
        entry.nonce === null ||
        entry.target === null ||
        getAddress(receipt.from) !== entry.sender ||
        (receipt.to === null ? null : getAddress(receipt.to)) !== entry.target
      ) {
        throw new Error('mined replacement does not match the durable hedge transaction identity')
      }
      this.activeIntentId = entry.id
      if (receipt.status === 'success') {
        this.confirm({
          transactionHash: receipt.transactionHash,
          blockNumber: receipt.blockNumber,
          blockHash: receipt.blockHash,
        })
      } else this.fail()
    }
    this.pruneTerminalIntents(latestBlock)
    this.persist()
  }

  checkpoint(): HedgeJournalCheckpoint {
    for (let index = this.data.intents.length - 1; index >= 0; index--) {
      const entry = this.data.intents[index]
      if (entry.status === 'confirmed' && entry.confirmedHash !== null) {
        return {
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
