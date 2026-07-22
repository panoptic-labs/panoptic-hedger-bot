import { mkdtempSync } from 'node:fs'
import { tmpdir } from 'node:os'
import path from 'node:path'

import type { Address, Hex } from 'viem'
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

function observe(target: HedgeJournal, hashes: readonly Hex[]) {
  target.observeTransaction({
    sender: SIGNER,
    nonce: 4,
    target: MODIFIER,
    calldataHash: CALLDATA_HASH,
    submittedAtBlock: 100n,
    hashes,
  })
}

function client(
  receipts: ReadonlyMap<Hex, 'success' | 'reverted'>,
  blockHash = BLOCK_HASH,
  discovered: Hex[] = [],
  latestBlock = 101n,
) {
  const recoveryClient: HedgeRecoveryClient = {
    getBlockNumber: async () => latestBlock,
    getBlock: async () => ({ hash: blockHash }),
    getTransactionReceipt: async ({ hash }) => {
      const status = receipts.get(hash)
      if (!status) throw new Error('receipt not found')
      return {
        transactionHash: hash,
        blockNumber: 101n,
        blockHash: BLOCK_HASH,
        from: SIGNER,
        to: MODIFIER,
        status,
      }
    },
    findMinedTransactions: async () => discovered,
  }
  return recoveryClient
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
    observe(first, [HASH_A, HASH_B])

    const restarted = journal()
    await restarted.recover(client(new Map([[HASH_B, 'success']])))

    expect(restarted.checkpoint()).toEqual({ transactionHash: HASH_B, fromBlock: 100n })
  })

  it('fails closed when no observed replacement has a receipt', async () => {
    const target = journal()
    target.begin('open')
    observe(target, [HASH_A])

    await expect(target.recover(client(new Map()))).rejects.toThrow(/operator review/)
  })

  it('recovers a post-broadcast crash by immutable sender/nonce/calldata identity', async () => {
    const target = journal()
    target.begin('open')
    observe(target, [])

    await target.recover(client(new Map([[HASH_A, 'success']]), BLOCK_HASH, [HASH_A]))
  })

  it('journals the new deleverage stage actions', async () => {
    for (const action of ['deleverage_loans', 'deleverage_options'] as const) {
      const target = journal()
      target.begin(action)
      observe(target, [HASH_A])
      const restarted = journal()
      await restarted.recover(client(new Map([[HASH_A, 'success']])))
      expect(restarted.checkpoint()).toEqual({ transactionHash: HASH_A, fromBlock: 100n })
    }
  })

  it('rejects replacement identity drift before it is persisted', () => {
    const target = journal()
    target.begin('open')
    observe(target, [HASH_A])

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

  it('rejects multiple mined replacements as ambiguous', async () => {
    const target = journal()
    target.begin('open')
    observe(target, [HASH_A, HASH_B])

    await expect(
      target.recover(
        client(
          new Map([
            [HASH_A, 'success'],
            [HASH_B, 'success'],
          ]),
        ),
      ),
    ).rejects.toThrow(/multiple replacements mined/)
  })

  it('detects a reorg of a previously confirmed hedge on restart', async () => {
    const target = journal()
    target.begin('open')
    observe(target, [HASH_A])
    target.confirm({ transactionHash: HASH_A, blockNumber: 101n, blockHash: BLOCK_HASH })

    const restarted = journal()
    await expect(restarted.recover(client(new Map([[HASH_A, 'success']]), HASH_B))).rejects.toThrow(
      /reorganized/,
    )
  })

  it('bounds restart RPC checks to recent confirmed intents', async () => {
    const target = journal()
    target.begin('open')
    observe(target, [HASH_A])
    target.confirm({ transactionHash: HASH_A, blockNumber: 101n, blockHash: BLOCK_HASH })

    const recoveryClient = client(new Map([[HASH_A, 'success']]), BLOCK_HASH, [], 1_000n)
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
})
