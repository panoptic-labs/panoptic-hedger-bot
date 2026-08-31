import { mkdtempSync } from 'node:fs'
import { tmpdir } from 'node:os'
import path from 'node:path'

import type { Address, Hex } from 'viem'
import { TransactionReceiptNotFoundError } from 'viem'
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'

import { type HedgeRecoveryClient, HedgeJournal } from './hedgeJournal'

const SAFE: Address = '0x1111111111111111111111111111111111111111'
const POOL: Address = '0x2222222222222222222222222222222222222222'
const SIGNER: Address = '0x3333333333333333333333333333333333333333'
const MODIFIER: Address = '0x4444444444444444444444444444444444444444'
const HASH_A: Hex = `0x${'aa'.repeat(32)}`
const HASH_B: Hex = `0x${'bb'.repeat(32)}`
const BLOCK_HASH: Hex = `0x${'cc'.repeat(32)}`
const CALLDATA_HASH: Hex = `0x${'dd'.repeat(32)}`

function journal() {
  return new HedgeJournal({ chainId: 1, safe: SAFE, pool: POOL, signer: SIGNER })
}

function persistIdentity(target: HedgeJournal, hashes: readonly Hex[] = []) {
  target.observeTransaction({
    sender: SIGNER,
    nonce: 4,
    target: MODIFIER,
    calldataHash: CALLDATA_HASH,
    submittedAtBlock: 100n,
    hashes,
  })
}

function broadcast(target: HedgeJournal, hashes: readonly Hex[]) {
  persistIdentity(target)
  target.recordBroadcastAttempt()
  persistIdentity(target, hashes)
}

interface ClientCaptured {
  nonceQueries: Address[]
}

function client(
  receipts: ReadonlyMap<Hex, 'success' | 'reverted'>,
  blockHash = BLOCK_HASH,
  chainNonce = 4,
  latestBlock = 101n,
): HedgeRecoveryClient & { captured: ClientCaptured } {
  const captured: ClientCaptured = { nonceQueries: [] }
  const recoveryClient: HedgeRecoveryClient = {
    getBlockNumber: async () => latestBlock,
    getBlock: async () => ({ hash: blockHash }),
    getTransactionReceipt: async ({ hash }) => {
      const status = receipts.get(hash)
      // Match production semantics: unknown-hash paths must throw the same viem
      // error class production catches; anything else propagates as transport.
      if (!status) throw new TransactionReceiptNotFoundError({ hash })
      return {
        transactionHash: hash,
        blockNumber: 101n,
        blockHash: BLOCK_HASH,
        from: SIGNER,
        to: MODIFIER,
        status,
      }
    },
    getTransactionCount: async (address) => {
      captured.nonceQueries.push(address)
      return chainNonce
    },
  }
  return Object.assign(recoveryClient, { captured })
}

describe('HedgeJournal', () => {
  beforeEach(() => {
    process.env.HEDGER_JOURNAL_PATH = path.join(
      mkdtempSync(path.join(tmpdir(), 'hedger-journal-')),
      'journal.json',
    )
  })

  afterEach(() => {
    delete process.env.HEDGER_JOURNAL_PATH
  })

  it('persists intent before send and recovers a late successful replacement', async () => {
    const first = journal()
    first.begin('open')
    broadcast(first, [HASH_A, HASH_B])

    const restarted = journal()
    await restarted.recover(client(new Map([[HASH_B, 'success']])))

    expect(restarted.checkpoint()).toMatchObject({ transactionHash: HASH_B, fromBlock: 100n })
  })

  it('keeps a fresh pending intent while the nonce slot is still open', async () => {
    const first = journal()
    first.begin('open')
    broadcast(first, [HASH_A])

    const restarted = journal()
    // chainNonce still at 4 (== entry.nonce), 10 blocks since submit — inside the stall window.
    const report = await restarted.recover(client(new Map(), BLOCK_HASH, 4, 110n))
    expect(report.held).toHaveLength(1)
    expect(report.held[0]).toMatchObject({
      action: 'open',
      nonce: 4,
      lastHash: HASH_A,
      blocksSinceSubmit: 10n,
      blocksRemaining: 54n,
    })
    expect(restarted.hasPendingIntent()).toBe(true)
    expect(() => restarted.begin('grow')).toThrow(/ambiguous pending hedge intent/)
  })

  it('per-cycle recovery confirms a held intent once its transaction mines', async () => {
    const first = journal()
    first.begin('open')
    broadcast(first, [HASH_A])

    const restarted = journal()
    // First pass: still in flight, held.
    const holdReport = await restarted.recover(client(new Map(), BLOCK_HASH, 4, 110n), {
      scope: 'pending',
    })
    expect(holdReport.held).toHaveLength(1)
    expect(restarted.hasPendingIntent()).toBe(true)

    // Second pass: the transaction mined; recovery confirms it in-process.
    const resolveReport = await restarted.recover(client(new Map([[HASH_A, 'success']])), {
      scope: 'pending',
    })
    expect(resolveReport.held).toHaveLength(0)
    expect(restarted.hasPendingIntent()).toBe(false)
    expect(restarted.checkpoint()).toMatchObject({ transactionHash: HASH_A })
    restarted.begin('grow')
  })

  it("scope 'pending' skips the confirmed-entry reorg recheck", async () => {
    const first = journal()
    first.begin('open')
    broadcast(first, [HASH_A])
    const restarted = journal()
    // Confirm the entry so the journal holds a recent confirmed record.
    await restarted.recover(client(new Map([[HASH_A, 'success']])))
    expect(restarted.hasPendingIntent()).toBe(false)

    const probing: HedgeRecoveryClient = {
      getBlockNumber: async () => 102n,
      getBlock: async () => {
        throw new Error('confirmed recheck must not run under pending scope')
      },
      getTransactionReceipt: async () => {
        throw new Error('confirmed recheck must not run under pending scope')
      },
      getTransactionCount: async () => 5,
    }
    const report = await restarted.recover(probing, { scope: 'pending' })
    expect(report.held).toHaveLength(0)
    // Full scope on the same client does probe the confirmed entry and throws.
    await expect(restarted.recover(probing)).rejects.toThrow(/must not run under pending scope/)
  })

  it('auto-fails a stalled pending intent whose nonce slot never advanced', async () => {
    const first = journal()
    first.begin('open')
    broadcast(first, [HASH_A])

    const restarted = journal()
    // chainNonce == entry.nonce (nothing landed) and 500 blocks past submit.
    const recoveryClient = client(new Map(), BLOCK_HASH, 4, 600n)
    await restarted.recover(recoveryClient)
    expect(restarted.checkpoint()).toEqual({})
    expect(recoveryClient.captured.nonceQueries).toEqual([SIGNER])
    restarted.begin('grow')
  })

  it('holds a pending intent at the nonceStallBlocks-1 boundary and auto-fails at the threshold', async () => {
    // submittedAtBlock=100n, default nonceStallBlocks=64n. At block 163 (delta 63)
    // the entry is still fresh; at block 164 (delta 64) it hits the threshold.
    const freshFirst = journal()
    freshFirst.begin('open')
    broadcast(freshFirst, [HASH_A])
    const fresh = journal()
    await fresh.recover(client(new Map(), BLOCK_HASH, 4, 163n))
    expect(() => fresh.begin('grow')).toThrow(/ambiguous pending hedge intent/)

    // Reset with a fresh journal file (new tempdir per test) via a second
    // in-process instance sharing the same env path is not equivalent — build a
    // fresh path so this case is independent of the prior one.
    process.env.HEDGER_JOURNAL_PATH = path.join(
      mkdtempSync(path.join(tmpdir(), 'hedger-journal-')),
      'journal.json',
    )
    const stalledFirst = journal()
    stalledFirst.begin('open')
    broadcast(stalledFirst, [HASH_A])
    const stalled = journal()
    await stalled.recover(client(new Map(), BLOCK_HASH, 4, 164n))
    expect(stalled.checkpoint()).toEqual({})
    stalled.begin('grow')
  })

  it('drops a pending intent whose nonce slot is spent on-chain', async () => {
    const first = journal()
    first.begin('open')
    broadcast(first, [HASH_A])

    const restarted = journal()
    // chainNonce > entry.nonce ⇒ something for that nonce landed; drop.
    const recoveryClient = client(new Map(), BLOCK_HASH, 5, 10_000n)
    await restarted.recover(recoveryClient)
    expect(restarted.checkpoint()).toEqual({})
    expect(recoveryClient.captured.nonceQueries).toEqual([SIGNER])
    restarted.begin('grow')
  })

  it('propagates transport failures from getTransactionReceipt instead of treating them as no-receipt', async () => {
    const first = journal()
    first.begin('open')
    broadcast(first, [HASH_A])

    const restarted = journal()
    const recoveryClient = client(new Map([[HASH_A, 'success']]))
    recoveryClient.getTransactionReceipt = async () => {
      throw new Error('RPC transport failure')
    }
    await expect(restarted.recover(recoveryClient)).rejects.toThrow(/RPC transport failure/)
  })

  it('recovers a crash after broadcast but before the transaction hash is observed', async () => {
    const first = journal()
    first.begin('open')
    persistIdentity(first)
    first.recordBroadcastAttempt()

    const restarted = journal()
    // No hashes in receipts map; chainNonce advanced past entry.nonce means the
    // tx landed under a hash we never captured — drop and re-derive next cycle.
    await restarted.recover(client(new Map(), BLOCK_HASH, 5, 200n))
    expect(restarted.checkpoint()).toEqual({})
    restarted.begin('grow')
  })

  it('uses a known mined hash without any block scan even far past submit', async () => {
    const target = journal()
    target.begin('grow')
    broadcast(target, [HASH_A])
    const recoveryClient = client(new Map([[HASH_A, 'success']]), BLOCK_HASH, 5, 10_000n)
    recoveryClient.getTransactionCount = vi.fn(recoveryClient.getTransactionCount)

    await target.recover(recoveryClient)

    // Fast path resolves via receipt without consulting the nonce.
    expect(recoveryClient.getTransactionCount).not.toHaveBeenCalled()
    expect(target.checkpoint()).toMatchObject({ transactionHash: HASH_A, fromBlock: 100n })
  })

  it('journals the non-planner transaction actions', async () => {
    for (const action of [
      'deleverage_loans',
      'deleverage_options',
      'sfpm_swap',
      'wallet_redeposit',
    ] as const) {
      const target = journal()
      target.begin(action)
      broadcast(target, [HASH_A])
      const restarted = journal()
      await restarted.recover(client(new Map([[HASH_A, 'success']])))
      expect(restarted.checkpoint()).toMatchObject({ transactionHash: HASH_A, fromBlock: 100n })
    }
  })

  it('rejects replacement identity drift before it is persisted', () => {
    const target = journal()
    target.begin('open')
    broadcast(target, [HASH_A])

    expect(() =>
      target.observeTransaction({
        sender: SIGNER,
        nonce: 5,
        target: MODIFIER,
        calldataHash: CALLDATA_HASH,
        submittedAtBlock: 100n,
        hashes: [HASH_A, HASH_B],
      }),
    ).toThrow(/replacement changed/)
  })

  it('resolves via the first successful replacement when multiple hashes mined', async () => {
    const target = journal()
    target.begin('open')
    broadcast(target, [HASH_A, HASH_B])

    await target.recover(
      client(
        new Map([
          [HASH_A, 'success'],
          [HASH_B, 'success'],
        ]),
      ),
    )
    expect(target.checkpoint()).toMatchObject({ transactionHash: HASH_A, fromBlock: 100n })
  })

  it('drops a pending intent whose recorded replacements all reverted', async () => {
    const target = journal()
    target.begin('open')
    broadcast(target, [HASH_A, HASH_B])

    await target.recover(
      client(
        new Map([
          [HASH_A, 'reverted'],
          [HASH_B, 'reverted'],
        ]),
      ),
    )
    expect(target.checkpoint()).toEqual({})
    target.begin('grow')
  })

  it('detects a reorg of a previously confirmed hedge on restart', async () => {
    const target = journal()
    target.begin('open')
    broadcast(target, [HASH_A])
    target.confirm({ transactionHash: HASH_A, blockNumber: 101n, blockHash: BLOCK_HASH })

    const restarted = journal()
    await expect(restarted.recover(client(new Map([[HASH_A, 'success']]), HASH_B))).rejects.toThrow(
      /reorganized/,
    )
  })

  it('bounds restart RPC checks to recent confirmed intents', async () => {
    const target = journal()
    target.begin('open')
    broadcast(target, [HASH_A])
    target.confirm({ transactionHash: HASH_A, blockNumber: 101n, blockHash: BLOCK_HASH })

    const recoveryClient = client(new Map([[HASH_A, 'success']]), BLOCK_HASH, 4, 1_000n)
    recoveryClient.getBlock = vi.fn(recoveryClient.getBlock)
    recoveryClient.getTransactionReceipt = vi.fn(recoveryClient.getTransactionReceipt)
    await journal().recover(recoveryClient)

    expect(recoveryClient.getBlock).not.toHaveBeenCalled()
    expect(recoveryClient.getTransactionReceipt).not.toHaveBeenCalled()
  })

  it('prunes failed intents so long-running instances do not exhaust the journal cap', () => {
    const target = journal()
    for (let index = 0; index < 300; index += 1) {
      target.begin('open')
      target.fail()
    }
    expect(target.checkpoint()).toEqual({})
  })

  it('rejects a journal bound to another signer identity', () => {
    const target = journal()
    target.begin('open')

    expect(
      () =>
        new HedgeJournal({
          chainId: 1,
          safe: SAFE,
          pool: POOL,
          signer: '0x5555555555555555555555555555555555555555',
        }),
    ).toThrow(/identity/)
  })

  it('auto-expires an intent when restart happens before transaction identity is persisted', async () => {
    const first = journal()
    first.begin('open')

    const restarted = journal()
    await restarted.recover(client(new Map(), BLOCK_HASH, 4, 200n))
    restarted.begin('grow')
  })

  it('auto-expires a prepared intent when no broadcast was attempted', async () => {
    const first = journal()
    first.begin('open')
    persistIdentity(first)

    const restarted = journal()
    const recoveryClient = client(new Map(), BLOCK_HASH, 4, 200n)
    recoveryClient.getTransactionCount = vi.fn(recoveryClient.getTransactionCount)
    await restarted.recover(recoveryClient)

    // Never broadcast ⇒ no need to consult the on-chain nonce.
    expect(recoveryClient.getTransactionCount).not.toHaveBeenCalled()
    restarted.begin('grow')
  })

  it('requires durable transaction identity before recording a broadcast attempt', () => {
    const target = journal()
    target.begin('open')

    expect(() => target.recordBroadcastAttempt()).toThrow(/identity must be durable/)
  })
})
