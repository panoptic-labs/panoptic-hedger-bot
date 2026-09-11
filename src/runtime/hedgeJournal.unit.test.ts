import { mkdtempSync } from 'node:fs'
import { tmpdir } from 'node:os'
import path from 'node:path'

import type { Address, Hex } from 'viem'
import { TransactionNotFoundError, TransactionReceiptNotFoundError } from 'viem'
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
  hashes.forEach((_hash, index) => {
    target.recordBroadcastAttempt()
    persistIdentity(target, hashes.slice(0, index + 1))
  })
}

interface ClientCaptured {
  nonceQueries: Address[]
  transactionQueries: Hex[]
}

function client(
  receipts: ReadonlyMap<Hex, 'success' | 'reverted'>,
  blockHash = BLOCK_HASH,
  chainNonce = 4,
  latestBlock = 101n,
  visibleTransactions: ReadonlySet<Hex> = new Set([HASH_A, HASH_B]),
): HedgeRecoveryClient & { captured: ClientCaptured } {
  const captured: ClientCaptured = { nonceQueries: [], transactionQueries: [] }
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
    getTransaction: async ({ hash }) => {
      captured.transactionQueries.push(hash)
      if (!visibleTransactions.has(hash)) throw new TransactionNotFoundError({ hash })
      return { hash }
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
    // chainNonce still at 4 (== entry.nonce), 6 blocks since submit — inside the stall window.
    const report = await restarted.recover(client(new Map(), BLOCK_HASH, 4, 106n))
    expect(report.held).toHaveLength(1)
    expect(report.held[0]).toMatchObject({
      action: 'open',
      nonce: 4,
      lastHash: HASH_A,
      blocksSinceSubmit: 6n,
      blocksRemaining: 2n,
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
    const holdReport = await restarted.recover(client(new Map(), BLOCK_HASH, 4, 106n), {
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
      getTransaction: async () => {
        throw new Error('confirmed recheck must not run under pending scope')
      },
      getTransactionCount: async () => 5,
    }
    const report = await restarted.recover(probing, { scope: 'pending' })
    expect(report.held).toHaveLength(0)
    // Full scope on the same client does probe the confirmed entry and throws.
    await expect(restarted.recover(probing)).rejects.toThrow(/must not run under pending scope/)
  })

  it('keeps legacy single-RPC recovery compatible with the two-block absence rule', async () => {
    const first = journal()
    first.begin('open')
    broadcast(first, [HASH_A])

    const restarted = journal()
    // chainNonce == entry.nonce (nothing landed) and 500 blocks past submit.
    const firstObserver = client(new Map(), BLOCK_HASH, 4, 600n, new Set())
    const firstReport = await restarted.recover(firstObserver)
    expect(firstReport.held[0]?.recoveryState).toMatch(/first mempool absence/)
    expect(restarted.hasPendingIntent()).toBe(true)
    expect(firstObserver.captured.nonceQueries).toEqual([SIGNER])
    expect(() => restarted.begin('grow')).toThrow(/ambiguous pending hedge intent/)

    const secondObserver = client(new Map(), BLOCK_HASH, 4, 601n, new Set())
    expect((await restarted.recover(secondObserver)).held).toEqual([])
    expect(restarted.hasPendingIntent()).toBe(false)
    restarted.begin('grow')
  })

  it('starts quorum recovery at the nonceStallBlocks threshold', async () => {
    // submittedAtBlock=100n, default nonceStallBlocks=8n. At block 107 (delta 7)
    // the entry is still fresh; at block 108 (delta 8) it hits the threshold.
    const freshFirst = journal()
    freshFirst.begin('open')
    broadcast(freshFirst, [HASH_A])
    const fresh = journal()
    await fresh.recover(client(new Map(), BLOCK_HASH, 4, 107n))
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
    const observerA = client(new Map(), BLOCK_HASH, 4, 108n, new Set())
    const observerB = client(new Map(), BLOCK_HASH, 4, 108n, new Set())
    const report = await stalled.recover(observerA, {
      mempoolObservers: [observerA, observerB],
    })
    expect(report.held[0]?.recoveryState).toMatch(/first mempool absence/)
    expect(stalled.hasPendingIntent()).toBe(true)
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

  it('releases an open nonce after two-provider absence on successive block observations', async () => {
    const first = journal()
    first.begin('open')
    broadcast(first, [HASH_A, HASH_B])

    const restarted = journal()
    const firstA = client(new Map(), BLOCK_HASH, 4, 108n, new Set())
    const firstB = client(new Map(), BLOCK_HASH, 4, 108n, new Set())
    const firstReport = await restarted.recover(firstA, {
      scope: 'pending',
      mempoolObservers: [firstA, firstB],
    })
    expect(firstReport.held[0]?.recoveryState).toMatch(/first mempool absence/)
    expect(restarted.hasPendingIntent()).toBe(true)

    const secondA = client(new Map(), BLOCK_HASH, 4, 109n, new Set())
    const secondB = client(new Map(), BLOCK_HASH, 4, 109n, new Set())
    const report = await restarted.recover(secondA, {
      scope: 'pending',
      mempoolObservers: [secondA, secondB],
    })

    expect(report.held).toEqual([])
    expect(restarted.hasPendingIntent()).toBe(false)
    expect(firstA.captured.transactionQueries).toEqual([HASH_A, HASH_B])
    expect(firstB.captured.transactionQueries).toEqual([HASH_A, HASH_B])
    expect(secondA.captured.transactionQueries).toEqual([HASH_A, HASH_B])
    expect(secondB.captured.transactionQueries).toEqual([HASH_A, HASH_B])
    restarted.begin('grow')
  })

  it('releases an open nonce when absence observations are three blocks apart', async () => {
    const first = journal()
    first.begin('open')
    broadcast(first, [HASH_A])

    const restarted = journal()
    const firstA = client(new Map(), BLOCK_HASH, 4, 108n, new Set())
    const firstB = client(new Map(), BLOCK_HASH, 4, 108n, new Set())
    expect(
      (
        await restarted.recover(firstA, {
          scope: 'pending',
          mempoolObservers: [firstA, firstB],
        })
      ).held,
    ).toHaveLength(1)

    const secondA = client(new Map(), BLOCK_HASH, 4, 111n, new Set())
    const secondB = client(new Map(), BLOCK_HASH, 4, 111n, new Set())
    expect(
      (
        await restarted.recover(secondA, {
          scope: 'pending',
          mempoolObservers: [secondA, secondB],
        })
      ).held,
    ).toEqual([])
    expect(restarted.hasPendingIntent()).toBe(false)
  })

  it('keeps an open nonce while either RPC sees a fee-bumped replacement', async () => {
    const first = journal()
    first.begin('open')
    broadcast(first, [HASH_A, HASH_B])

    const restarted = journal()
    const observerA = client(new Map(), BLOCK_HASH, 4, 108n, new Set())
    const observerB = client(new Map(), BLOCK_HASH, 4, 108n, new Set([HASH_B]))
    const report = await restarted.recover(observerA, {
      scope: 'pending',
      mempoolObservers: [observerA, observerB],
    })

    expect(report.held).toHaveLength(1)
    expect(report.held[0]?.recoveryState).toMatch(/remains visible/)
    expect(restarted.hasPendingIntent()).toBe(true)
    expect(observerA.captured.transactionQueries).toEqual([HASH_A, HASH_B])
    expect(observerB.captured.transactionQueries).toEqual([HASH_A, HASH_B])
  })

  it('resets consecutive absence when either RPC sees a replacement', async () => {
    const first = journal()
    first.begin('open')
    broadcast(first, [HASH_A])
    const restarted = journal()

    const recoverAt = async (block: bigint, visibleB: ReadonlySet<Hex>) => {
      const observerA = client(new Map(), BLOCK_HASH, 4, block, new Set())
      const observerB = client(new Map(), BLOCK_HASH, 4, block, visibleB)
      return restarted.recover(observerA, {
        scope: 'pending',
        mempoolObservers: [observerA, observerB],
      })
    }

    expect((await recoverAt(108n, new Set())).held).toHaveLength(1)
    expect((await recoverAt(109n, new Set([HASH_A]))).held[0]?.recoveryState).toMatch(/visible/)
    expect((await recoverAt(110n, new Set())).held[0]?.recoveryState).toMatch(/first mempool/)
    expect(restarted.hasPendingIntent()).toBe(true)
    expect((await recoverAt(111n, new Set())).held).toEqual([])
    expect(restarted.hasPendingIntent()).toBe(false)
  })

  it('deduplicates a repeated RPC observer without blocking legacy recovery', async () => {
    const first = journal()
    first.begin('open')
    broadcast(first, [HASH_A])
    const restarted = journal()
    const firstObserver = client(new Map(), BLOCK_HASH, 4, 108n, new Set())

    const firstReport = await restarted.recover(firstObserver, {
      mempoolObservers: [firstObserver, firstObserver],
    })
    expect(firstReport.held[0]?.recoveryState).toMatch(/first mempool absence/)

    const secondObserver = client(new Map(), BLOCK_HASH, 4, 109n, new Set())
    expect(
      (
        await restarted.recover(secondObserver, {
          mempoolObservers: [secondObserver, secondObserver],
        })
      ).held,
    ).toEqual([])
    expect(restarted.hasPendingIntent()).toBe(false)
  })

  it('keeps an open nonce when a crash may have lost the latest broadcast hash', async () => {
    const first = journal()
    first.begin('open')
    broadcast(first, [HASH_A])
    // Durable pre-broadcast marker for the replacement, followed by a crash
    // before sendTransaction's returned hash could be observed.
    first.recordBroadcastAttempt()

    const restarted = journal()
    const recoveryClient = client(new Map(), BLOCK_HASH, 4, 106n, new Set())
    const report = await restarted.recover(recoveryClient, { scope: 'pending' })

    expect(report.held).toHaveLength(1)
    expect(restarted.hasPendingIntent()).toBe(true)
    expect(recoveryClient.captured.transactionQueries).toEqual([])
  })

  it('does not fence an explicitly rejected replacement as an unknown broadcast', async () => {
    const first = journal()
    first.begin('open')
    broadcast(first, [HASH_A])
    first.recordBroadcastAttempt()
    first.recordBroadcastRejection()

    const restarted = journal()
    const firstObserver = client(new Map(), BLOCK_HASH, 4, 108n, new Set())
    const firstReport = await restarted.recover(firstObserver, { scope: 'pending' })
    expect(firstReport.held[0]?.recoveryState).toMatch(/first mempool absence/)

    const secondObserver = client(new Map(), BLOCK_HASH, 4, 109n, new Set())
    expect((await restarted.recover(secondObserver, { scope: 'pending' })).held).toEqual([])
    expect(restarted.hasPendingIntent()).toBe(false)
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

  it('propagates transport failures from getTransaction instead of treating them as a mempool drop', async () => {
    const first = journal()
    first.begin('open')
    broadcast(first, [HASH_A])

    const restarted = journal()
    const recoveryClient = client(new Map(), BLOCK_HASH, 4, 108n)
    const secondObserver = client(new Map(), BLOCK_HASH, 4, 108n)
    recoveryClient.getTransaction = async () => {
      throw new Error('RPC transport failure')
    }
    await expect(
      restarted.recover(recoveryClient, {
        mempoolObservers: [recoveryClient, secondObserver],
      }),
    ).rejects.toThrow(/RPC transport failure/)
    expect(restarted.hasPendingIntent()).toBe(true)
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

  it('rejects a broadcast rejection without an unresolved attempt', () => {
    const target = journal()
    target.begin('open')
    persistIdentity(target)

    expect(() => target.recordBroadcastRejection()).toThrow(/no unresolved attempt/)
  })
})
