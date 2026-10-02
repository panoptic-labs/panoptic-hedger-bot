import type { Address, Hex, PublicClient, TransactionReceipt } from 'viem'
import { decodeFunctionData, encodeFunctionData, getAddress, parseAbi } from 'viem'
import { describe, expect, it, vi } from 'vitest'

import { createKeeperSender, TxNotMinedError } from './keeperSender'
import {
  type SignedSafeTxRelayDeps,
  createSignedSafeTxRelay,
  grantsBotControl,
  packThresholdSignatures,
  safeExecTransactionAbi,
} from './signedTxRelay'

const SAFE = getAddress(`0x${'5a'.repeat(20)}`)
const BOT = getAddress(`0x${'b0'.repeat(20)}`)
const OWNER_LOW = getAddress(`0x${'01'.repeat(20)}`)
const OWNER_MID = getAddress(`0x${'02'.repeat(20)}`)
const OWNER_HIGH = getAddress(`0x${'03'.repeat(20)}`)
const OUTSIDER = getAddress(`0x${'04'.repeat(20)}`)
const TARGET = getAddress(`0x${'7e'.repeat(20)}`)
const SAFE_TX_HASH = `0x${'aa'.repeat(32)}` as const
const TX_HASH = `0x${'cc'.repeat(32)}` as const

const ecdsa = (fill: string, v = '1f'): Hex => `0x${fill.repeat(64)}${v}`
const approvedHash = (owner: Address): Hex =>
  `0x${owner.slice(2).toLowerCase().padStart(64, '0')}${'00'.repeat(32)}01`

function queuedTx(overrides: Record<string, unknown> = {}) {
  return {
    safe: SAFE,
    to: TARGET,
    value: '0',
    data: '0x',
    operation: 0,
    safeTxGas: '0',
    baseGas: '0',
    gasPrice: '0',
    gasToken: '0x0000000000000000000000000000000000000000',
    refundReceiver: '0x0000000000000000000000000000000000000000',
    nonce: '7',
    safeTxHash: SAFE_TX_HASH,
    isExecuted: false,
    confirmations: [
      { owner: OWNER_HIGH, signature: ecdsa('33'), signatureType: 'EOA' },
      { owner: OWNER_LOW, signature: ecdsa('11'), signatureType: 'EOA' },
    ],
    ...overrides,
  }
}

function makeDeps(
  results: unknown[],
  overrides: Partial<SignedSafeTxRelayDeps> = {},
): SignedSafeTxRelayDeps {
  const publicClient = {
    readContract: vi.fn(async ({ functionName }: { functionName: string }) => {
      if (functionName === 'nonce') return 7n
      if (functionName === 'getThreshold') return 2n
      return [OWNER_LOW, OWNER_MID, OWNER_HIGH]
    }),
    call: vi.fn(async () => ({ data: `0x${'0'.repeat(63)}1` })),
    estimateGas: vi.fn(async () => 200_000n),
  } as unknown as PublicClient
  const receipt = {
    status: 'success',
    transactionHash: TX_HASH,
    blockNumber: 100n,
    blockHash: `0x${'dd'.repeat(32)}`,
  } as TransactionReceipt
  return {
    publicClient,
    sender: { send: vi.fn(async () => receipt) },
    gasPolicy: {
      assess: vi.fn(async () => ({
        proceed: true,
        urgent: false,
        baseFeeGwei: '10',
        capGwei: '50',
        shouldNotifySkip: false,
      })),
    },
    hedgeJournal: { begin: vi.fn(() => 'id'), confirm: vi.fn(), fail: vi.fn() },
    fetch: vi.fn(async () => new Response(JSON.stringify({ results }))) as typeof fetch,
    serviceUrl: 'https://service.invalid/tx-service/eth',
    safeAddress: SAFE,
    botAddress: BOT,
    dryRun: false,
    ...overrides,
  }
}

function sentSignatures(deps: SignedSafeTxRelayDeps): Hex {
  const [[tx]] = vi.mocked(deps.sender.send).mock.calls
  const decoded = decodeFunctionData({ abi: safeExecTransactionAbi, data: tx.data })
  if (decoded.functionName !== 'execTransaction') throw new Error('unexpected call')
  return decoded.args[9]
}

describe('packThresholdSignatures', () => {
  const owners = [OWNER_LOW, OWNER_MID, OWNER_HIGH]

  it('orders owners ascending and keeps exactly threshold signatures', () => {
    const packed = packThresholdSignatures(
      [
        { owner: OWNER_HIGH, signature: ecdsa('33'), signatureType: 'EOA' },
        { owner: OWNER_MID, signature: approvedHash(OWNER_MID), signatureType: 'APPROVED_HASH' },
        { owner: OWNER_LOW, signature: ecdsa('11', '1b'), signatureType: 'EOA' },
      ],
      owners,
      2n,
    )
    expect(packed).toBe(`${ecdsa('11', '1b')}${approvedHash(OWNER_MID).slice(2)}`)
  })

  it('matches the Safe Transaction Service packing for a real mainnet transaction', () => {
    // Safe 0x8CF60B289f8d31F737049B590b5E4285Ff0Bd1D1, nonce 74 (threshold 3, executed in block 26045270).
    const confirmations = [
      {
        owner: '0xb1Df01604095536CEA66a9D06E67Ed6F00684e58',
        signature:
          '0x31255a6a316bed61ccf32effcfff8fba6f0c5aa4bf26c78a183efc6abb65e12406713b4efdc190fe1b31962aefa4d0064e772b47ba9d1e8f7a0a26b453db105b1c',
        signatureType: 'EOA',
      },
      {
        owner: '0x6b28FdCF3059dd13847648213175dCa8853557B5',
        signature:
          '0x0000000000000000000000006b28fdcf3059dd13847648213175dca8853557b5000000000000000000000000000000000000000000000000000000000000000001',
        signatureType: 'APPROVED_HASH',
      },
      {
        owner: '0x3242071b0b406B6661AF2dE1115CD46567Ab0917',
        signature:
          '0xe7e01b3727e8d91dfd9cd06e7e6c7ad95278500719d3444f270fe9840f43e4bb497593b44660fcee8e04d0f351e1f3f9c317f5b9c8f8e594b3f1883e36b3819f1c',
        signatureType: 'EOA',
      },
    ] as const
    const serviceSignatures =
      '0x' +
      'e7e01b3727e8d91dfd9cd06e7e6c7ad95278500719d3444f270fe9840f43e4bb497593b44660fcee8e04d0f351e1f3f9c317f5b9c8f8e594b3f1883e36b3819f1c' +
      '0000000000000000000000006b28fdcf3059dd13847648213175dca8853557b5000000000000000000000000000000000000000000000000000000000000000001' +
      '31255a6a316bed61ccf32effcfff8fba6f0c5aa4bf26c78a183efc6abb65e12406713b4efdc190fe1b31962aefa4d0064e772b47ba9d1e8f7a0a26b453db105b1c'
    const owners = confirmations.map((confirmation) => getAddress(confirmation.owner))
    expect(packThresholdSignatures(confirmations, owners, 3n)).toBe(serviceSignatures)
  })

  it('ignores non-owners, contract signatures, and malformed signatures', () => {
    const packed = packThresholdSignatures(
      [
        { owner: OUTSIDER, signature: ecdsa('44'), signatureType: 'EOA' },
        { owner: OWNER_MID, signature: ecdsa('22', '00'), signatureType: 'CONTRACT_SIGNATURE' },
        { owner: OWNER_HIGH, signature: '0x1234', signatureType: 'EOA' },
        { owner: OWNER_LOW, signature: ecdsa('11'), signatureType: 'EOA' },
      ],
      owners,
      2n,
    )
    expect(packed).toBeNull()
  })

  it('returns null below the on-chain threshold', () => {
    expect(
      packThresholdSignatures(
        [{ owner: OWNER_LOW, signature: ecdsa('11'), signatureType: 'EOA' }],
        owners,
        2n,
      ),
    ).toBeNull()
  })
})

describe('grantsBotControl', () => {
  const ownerAbi = parseAbi([
    'function addOwnerWithThreshold(address owner, uint256 threshold)',
    'function swapOwner(address prevOwner, address oldOwner, address newOwner)',
  ])

  it('flags owner grants to the bot, including nested in a batch', () => {
    const add = encodeFunctionData({
      abi: ownerAbi,
      functionName: 'addOwnerWithThreshold',
      args: [BOT, 1n],
    })
    const swap = encodeFunctionData({
      abi: ownerAbi,
      functionName: 'swapOwner',
      args: [OWNER_LOW, OWNER_MID, BOT],
    })
    expect(grantsBotControl(add, BOT)).toBe(true)
    expect(grantsBotControl(`0x8d80ff0a${swap.slice(2)}`, BOT)).toBe(true)
  })

  it('allows owner changes that do not involve the bot', () => {
    const add = encodeFunctionData({
      abi: ownerAbi,
      functionName: 'addOwnerWithThreshold',
      args: [OUTSIDER, 1n],
    })
    expect(grantsBotControl(add, BOT)).toBe(false)
  })
})

describe('createSignedSafeTxRelay', () => {
  it('executes the fully-signed transaction at the current nonce and journals it', async () => {
    const deps = makeDeps([queuedTx()])
    const outcome = await createSignedSafeTxRelay(deps).relayNext()

    expect(outcome).toEqual({
      kind: 'executed',
      safeTxHash: SAFE_TX_HASH,
      nonce: 7n,
      transactionHash: TX_HASH,
    })
    expect(vi.mocked(deps.fetch).mock.calls[0][0]).toContain(
      `/api/v2/safes/${SAFE}/multisig-transactions/?executed=false&nonce=7`,
    )
    expect(sentSignatures(deps)).toBe(`${ecdsa('11')}${ecdsa('33').slice(2)}`)
    expect(deps.hedgeJournal.begin).toHaveBeenCalledWith('safe_relay')
    expect(deps.hedgeJournal.confirm).toHaveBeenCalledOnce()
    expect(deps.hedgeJournal.fail).not.toHaveBeenCalled()
  })

  it('is idle when nothing at the current nonce reaches the threshold', async () => {
    const underSigned = queuedTx({
      confirmations: [{ owner: OWNER_LOW, signature: ecdsa('11'), signatureType: 'EOA' }],
    })
    const staleNonce = queuedTx({ nonce: '6' })
    const deps = makeDeps([underSigned, staleNonce, { unexpected: 'shape' }])
    expect(await createSignedSafeTxRelay(deps).relayNext()).toEqual({ kind: 'idle' })
    expect(deps.sender.send).not.toHaveBeenCalled()
  })

  it.each([
    '0x',
    `0x${'aa'.repeat(31)}`,
    `0x${'aa'.repeat(33)}`,
    `0x${'a'.repeat(63)}`,
    'aa'.repeat(32),
    `0x${'gg'.repeat(32)}`,
  ])('ignores a queued transaction with malformed safeTxHash %s', async (safeTxHash) => {
    const deps = makeDeps([queuedTx({ safeTxHash })])
    expect(await createSignedSafeTxRelay(deps).relayNext()).toEqual({ kind: 'idle' })
    expect(deps.publicClient.call).not.toHaveBeenCalled()
    expect(deps.sender.send).not.toHaveBeenCalled()
    expect(deps.hedgeJournal.begin).not.toHaveBeenCalled()
  })

  it('refuses to choose between competing fully-signed transactions', async () => {
    const deps = makeDeps([queuedTx(), queuedTx({ safeTxHash: `0x${'bb'.repeat(32)}` })])
    const outcome = await createSignedSafeTxRelay(deps).relayNext()
    expect(outcome).toMatchObject({
      kind: 'skipped',
      code: 'conflict',
      reason: expect.stringMatching(/compete/),
    })
    expect(deps.sender.send).not.toHaveBeenCalled()
  })

  it.each([
    ['a Safe gas refund', { gasPrice: '1' }, /gas refund/],
    ['a non-zero safeTxGas', { safeTxGas: '50000' }, /safeTxGas/],
    [
      'an owner grant to the bot',
      {
        to: SAFE,
        data: encodeFunctionData({
          abi: parseAbi(['function addOwnerWithThreshold(address owner, uint256 threshold)']),
          functionName: 'addOwnerWithThreshold',
          args: [BOT, 1n],
        }),
      },
      /owner or module/,
    ],
    [
      'enabling the bot as a module',
      {
        to: SAFE,
        data: encodeFunctionData({
          abi: parseAbi(['function enableModule(address module)']),
          functionName: 'enableModule',
          args: [BOT],
        }),
      },
      /owner or module/,
    ],
  ])('refuses %s', async (_, overrides, reason) => {
    const deps = makeDeps([queuedTx(overrides)])
    const outcome = await createSignedSafeTxRelay(deps).relayNext()
    expect(outcome).toMatchObject({ kind: 'skipped', reason: expect.stringMatching(reason) })
    expect(deps.sender.send).not.toHaveBeenCalled()
  })

  it('skips without sending when the Safe rejects the signatures in simulation', async () => {
    const deps = makeDeps([queuedTx()])
    vi.mocked(deps.publicClient.call).mockRejectedValueOnce(new Error('GS026'))
    const outcome = await createSignedSafeTxRelay(deps).relayNext()
    expect(outcome).toMatchObject({ kind: 'skipped', reason: expect.stringMatching(/GS026/) })
    expect(deps.hedgeJournal.begin).not.toHaveBeenCalled()
  })

  it('skips transactions above the keeper gas cap', async () => {
    const deps = makeDeps([queuedTx()])
    vi.mocked(deps.publicClient.estimateGas).mockResolvedValueOnce(5_000_000n)
    const outcome = await createSignedSafeTxRelay(deps).relayNext()
    expect(outcome).toMatchObject({ kind: 'skipped', reason: expect.stringMatching(/cap/) })
  })

  it('simulates but never sends in dry-run', async () => {
    const deps = makeDeps([queuedTx()], { dryRun: true })
    const outcome = await createSignedSafeTxRelay(deps).relayNext()
    expect(outcome).toEqual({ kind: 'simulated', safeTxHash: SAFE_TX_HASH, nonce: 7n })
    expect(deps.sender.send).not.toHaveBeenCalled()
    expect(deps.hedgeJournal.begin).not.toHaveBeenCalled()
  })

  it('defers when the basefee gate says so', async () => {
    const deps = makeDeps([queuedTx()])
    vi.mocked(deps.gasPolicy.assess).mockResolvedValueOnce({
      proceed: false,
      urgent: false,
      baseFeeGwei: '80',
      capGwei: '50',
      shouldNotifySkip: true,
    })
    const outcome = await createSignedSafeTxRelay(deps).relayNext()
    expect(outcome).toMatchObject({
      kind: 'deferred',
      reason: expect.stringMatching(/basefee/),
      shouldNotify: true,
    })
    expect(deps.sender.send).not.toHaveBeenCalled()
  })

  it.each([
    new TxNotMinedError([TX_HASH], 1_000),
    new Error('receipt RPC unavailable'),
    new Error('post-broadcast journal write failed'),
  ])('leaves a broadcast relay pending after %s', async (error) => {
    const deps = makeDeps([queuedTx()])
    vi.mocked(deps.sender.send).mockImplementationOnce(async (_tx, options) => {
      options?.onBroadcastAttempt?.()
      throw error
    })
    await expect(createSignedSafeTxRelay(deps).relayNext()).rejects.toBe(error)
    expect(deps.hedgeJournal.fail).not.toHaveBeenCalled()
    expect(deps.hedgeJournal.confirm).not.toHaveBeenCalled()
  })

  it('fails the journal intent when sending fails before a broadcast attempt', async () => {
    const deps = makeDeps([queuedTx()])
    const error = new Error('gas estimation failed')
    vi.mocked(deps.sender.send).mockRejectedValueOnce(error)
    await expect(createSignedSafeTxRelay(deps).relayNext()).rejects.toBe(error)
    expect(deps.hedgeJournal.fail).toHaveBeenCalledOnce()
    expect(deps.hedgeJournal.confirm).not.toHaveBeenCalled()
  })

  it.each([false, true])(
    'preserves recovery across an ambiguous broadcast with EIP-1559=%s',
    async (eip1559) => {
      const deps = makeDeps([queuedTx()])
      const error = new Error('connection reset during broadcast')
      const recordBroadcastAttempt = vi.fn()
      const sendTransaction = vi.fn().mockRejectedValue(error)
      deps.sender = createKeeperSender({
        publicClient: {
          ...deps.publicClient,
          getTransactionCount: vi.fn().mockResolvedValue(0),
          getBlockNumber: vi.fn().mockResolvedValue(100n),
        } as unknown as PublicClient,
        walletClient: { sendTransaction } as unknown as Parameters<
          typeof createKeeperSender
        >[0]['walletClient'],
        account: { address: BOT, type: 'json-rpc' },
        safeAddress: SAFE,
        observeTransaction: vi.fn(),
        recordBroadcastAttempt,
        recordBroadcastRejection: vi.fn(),
        assertSendAllowed: vi.fn(),
        ...(eip1559
          ? {
              fees: async () => ({ maxFeePerGas: 10n, maxPriorityFeePerGas: 1n }),
              bumpFees: async () => null,
              txWait: { timeoutMs: 1_000 },
            }
          : {}),
      })
      await expect(createSignedSafeTxRelay(deps).relayNext()).rejects.toBe(error)
      expect(recordBroadcastAttempt).toHaveBeenCalledOnce()
      expect(sendTransaction).toHaveBeenCalledOnce()
      expect(deps.hedgeJournal.fail).not.toHaveBeenCalled()
      expect(deps.hedgeJournal.confirm).not.toHaveBeenCalled()
    },
  )

  it('fails the journal intent on a reverted relay', async () => {
    const deps = makeDeps([queuedTx()])
    vi.mocked(deps.sender.send).mockResolvedValueOnce({
      status: 'reverted',
      transactionHash: TX_HASH,
    } as TransactionReceipt)
    await expect(createSignedSafeTxRelay(deps).relayNext()).rejects.toThrow(/reverted/)
    expect(deps.hedgeJournal.fail).toHaveBeenCalledOnce()
  })
})
