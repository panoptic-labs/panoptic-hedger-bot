import type { Account, Address, Hex } from 'viem'
import { decodeFunctionData, toFunctionSelector, TransactionReceiptNotFoundError } from 'viem'
import { describe, expect, it, vi } from 'vitest'

import { rolesModifierV2Abi } from './rolesAbi'
import {
  type RolesCall,
  type RolesExecutorDeps,
  createRolesExecutor,
  TxNotMinedError,
} from './rolesExecutor'

const ROLES_MODIFIER: Address = '0x0000000000000000000000000000000000000AbC'
const SAFE: Address = '0x1111111111111111111111111111111111111111'
const POOL: Address = '0x2222222222222222222222222222222222222222'
const ROLE_KEY: Hex = ('0x' + 'ab'.repeat(32)) as Hex
const BOT: Address = '0x3333333333333333333333333333333333333333'

const DISPATCH_DATA: Hex = '0xdeadbeef'

const account = { address: BOT, type: 'json-rpc' } as unknown as Account

const CALL: RolesCall = { to: POOL, value: 0n, data: DISPATCH_DATA, operation: 0 }

const receipt = (transactionHash: string) =>
  ({
    transactionHash,
    status: 'success',
    blockNumber: 123n,
    blockHash: `0x${'ab'.repeat(32)}`,
  }) as never

function makeDeps(overrides: Partial<RolesExecutorDeps> = {}): RolesExecutorDeps {
  const publicClient = {
    readContract: vi.fn().mockResolvedValue([SAFE]),
    getTransactionCount: vi.fn().mockResolvedValue(0),
    getBlockNumber: vi.fn().mockResolvedValue(123n),
    waitForTransactionReceipt: vi.fn(async ({ hash }: { hash: string }) => receipt(hash)),
    ...(overrides.publicClient ?? {}),
  } as RolesExecutorDeps['publicClient']
  return {
    walletClient: {} as RolesExecutorDeps['walletClient'],
    account,
    rolesModifierAddress: ROLES_MODIFIER,
    roleKey: ROLE_KEY,
    safeAddress: SAFE,
    observeTransaction: vi.fn(),
    assertSendAllowed: vi.fn(),
    ...overrides,
    publicClient,
  }
}

describe('RolesExecutor.wrapCalldata', () => {
  it('encodes execTransactionWithRole with the correct selector', () => {
    const exec = createRolesExecutor(makeDeps())
    const data = exec.wrapCalldata(CALL)
    const expectedSelector = toFunctionSelector(
      'execTransactionWithRole(address,uint256,bytes,uint8,bytes32,bool)',
    )
    expect(data.slice(0, 10)).toBe(expectedSelector)
  })

  it('round-trips all six args, forcing shouldRevert=true and the configured roleKey', () => {
    const exec = createRolesExecutor(makeDeps())
    const data = exec.wrapCalldata(CALL)

    const decoded = decodeFunctionData({ abi: rolesModifierV2Abi, data })
    expect(decoded.functionName).toBe('execTransactionWithRole')
    const [to, value, callData, operation, roleKey, shouldRevert] = decoded.args as [
      Address,
      bigint,
      Hex,
      number,
      Hex,
      boolean,
    ]
    expect(to.toLowerCase()).toBe(POOL.toLowerCase())
    expect(value).toBe(0n)
    expect(callData).toBe(DISPATCH_DATA)
    expect(operation).toBe(0)
    expect(roleKey).toBe(ROLE_KEY)
    expect(shouldRevert).toBe(true)
  })
})

describe('RolesExecutor.send', () => {
  it('sends the wrapped calldata to the modifier from the bot account', async () => {
    const sendTransaction = vi.fn().mockResolvedValue('0xhash')
    const exec = createRolesExecutor(
      makeDeps({
        walletClient: { sendTransaction, chain: null } as never,
      }),
    )
    const mined = await exec.send(CALL)
    expect(mined.transactionHash).toBe('0xhash')
    expect(sendTransaction).toHaveBeenCalledTimes(1)
    const arg = sendTransaction.mock.calls[0][0]
    expect(arg.to).toBe(ROLES_MODIFIER)
    expect(arg.value).toBe(0n)
    expect(arg.account).toBe(account)
    expect(arg.data).toBe(exec.wrapCalldata(CALL))
  })

  it('fails before sending when ownership drift makes the bot a Safe owner', async () => {
    const sendTransaction = vi.fn()
    const readContract = vi.fn().mockResolvedValue([SAFE, BOT])
    const exec = createRolesExecutor(
      makeDeps({
        publicClient: { readContract } as never,
        walletClient: { sendTransaction, chain: null } as never,
      }),
    )

    await expect(exec.send(CALL)).rejects.toThrow(/bot .* is an owner/i)
    expect(sendTransaction).not.toHaveBeenCalled()
  })

  it('fails at the immediate broadcast fence after a cycle was already planned', async () => {
    const sendTransaction = vi.fn()
    const observeTransaction = vi.fn()
    const exec = createRolesExecutor(
      makeDeps({
        walletClient: { sendTransaction, chain: null } as never,
        observeTransaction,
        assertSendAllowed: vi.fn(() => {
          throw new Error('emergency deactivation is active')
        }),
      }),
    )

    await expect(exec.send(CALL)).rejects.toThrow(/deactivation is active/)
    expect(sendTransaction).not.toHaveBeenCalled()
    expect(observeTransaction).not.toHaveBeenCalled()
  })
})

describe('RolesExecutor.send — confirm-with-escalation', () => {
  const FEES_A = { maxFeePerGas: 100n, maxPriorityFeePerGas: 1n }
  const FEES_B = { maxFeePerGas: 200n, maxPriorityFeePerGas: 2n }
  const NONCE = 7
  const GAS = 123_456n
  // Virtual-clock timings: budget 90, bump every 30, receipt poll every 10.
  const TX_WAIT = { timeoutMs: 90, bumpIntervalMs: 30, pollIntervalMs: 10 }

  /**
   * Escalation harness on a virtual clock (now/sleep injected): sendTransaction
   * yields 0xhash1, 0xhash2, … (or throws per `sendErrors`), and a hash's
   * receipt exists once the clock reaches its `mineAt` time.
   */
  function makeHarness(opts: {
    /** attempt index (0-based) → mined-at virtual time */
    mineAt?: Record<number, number>
    /** attempt index (0-based) → error thrown instead of returning a hash */
    sendErrors?: Record<number, Error>
    /** Sequential bumpFees results; an Error entry is thrown instead. */
    bumpQueue?: (typeof FEES_A | null | Error)[]
    fees?: typeof FEES_A
  }) {
    let t = 0
    const mineTimes = new Map<string, number>()
    let attempt = 0
    const sendTransaction = vi.fn(async (_args: Record<string, unknown>) => {
      const i = attempt++
      const err = opts.sendErrors?.[i]
      if (err) throw err
      const hash = `0xhash${i + 1}`
      const at = opts.mineAt?.[i]
      if (at !== undefined) mineTimes.set(hash, at)
      return hash
    })
    const getTransactionReceipt = vi.fn(async ({ hash }: { hash: Hex }) => {
      const at = mineTimes.get(hash)
      if (at === undefined || t < at) throw new TransactionReceiptNotFoundError({ hash })
      return receipt(hash)
    })
    const bumpQueue = [...(opts.bumpQueue ?? [])]
    const fees = vi.fn(async () => opts.fees ?? FEES_A)
    const bumpFees = vi.fn(async () => {
      const next = bumpQueue.shift()
      if (next instanceof Error) throw next
      return next === undefined ? null : next
    })
    const deps = makeDeps({
      publicClient: {
        getTransactionCount: vi.fn(async () => NONCE),
        getBlockNumber: vi.fn(async () => 123n),
        estimateGas: vi.fn(async () => GAS),
        getTransactionReceipt,
      } as never,
      walletClient: { sendTransaction, chain: null } as never,
      fees,
      bumpFees,
      txWait: TX_WAIT,
      now: () => t,
      sleep: async (ms: number) => {
        t += ms
      },
    })
    return { exec: createRolesExecutor(deps), sendTransaction, fees, bumpFees, deps }
  }

  it('waits for confirmation without fee escalation when fees are unavailable', async () => {
    const sendTransaction = vi.fn().mockResolvedValue('0xhash')
    const getTransactionCount = vi.fn().mockResolvedValue(0)
    const getTransactionReceipt = vi.fn(async () => receipt('0xhash'))
    const exec = createRolesExecutor(
      makeDeps({
        publicClient: {
          getTransactionCount,
          getBlockNumber: vi.fn().mockResolvedValue(123n),
          getTransactionReceipt,
        } as never,
        walletClient: { sendTransaction, chain: null } as never,
        fees: async () => undefined,
        bumpFees: async () => null,
        txWait: TX_WAIT,
      }),
    )
    expect((await exec.send(CALL)).transactionHash).toBe('0xhash')
    expect(getTransactionCount).toHaveBeenCalledTimes(1)
    expect(sendTransaction.mock.calls[0][0].nonce).toBe(0)
  })

  it('uses the configured receipt budget without fee escalation', async () => {
    let t = 0
    const hash = '0x01' as Hex
    const exec = createRolesExecutor(
      makeDeps({
        publicClient: {
          getTransactionReceipt: vi.fn(async () => {
            throw new TransactionReceiptNotFoundError({ hash })
          }),
        } as never,
        walletClient: { sendTransaction: vi.fn(async () => hash), chain: null } as never,
        fees: async () => undefined,
        bumpFees: async () => null,
        txWait: TX_WAIT,
        now: () => t,
        sleep: async (ms: number) => {
          t += ms
        },
      }),
    )

    const error = await exec.send(CALL).catch((caught: unknown) => caught)
    expect(error).toBeInstanceOf(TxNotMinedError)
    expect((error as TxNotMinedError).lastHash).toBe(hash)
    expect(t).toBe(TX_WAIT.timeoutMs)
  })

  it('pins the pending nonce + gas and returns the hash once mined', async () => {
    const { exec, sendTransaction, deps } = makeHarness({ mineAt: { 0: 15 } })
    expect((await exec.send(CALL)).transactionHash).toBe('0xhash1')
    expect(sendTransaction).toHaveBeenCalledTimes(1)
    const arg = sendTransaction.mock.calls[0][0]
    expect(arg.nonce).toBe(NONCE)
    expect(arg.gas).toBe(GAS)
    expect(arg.maxFeePerGas).toBe(FEES_A.maxFeePerGas)
    const pc = deps.publicClient as unknown as { getTransactionCount: ReturnType<typeof vi.fn> }
    expect(pc.getTransactionCount).toHaveBeenCalledWith({
      address: BOT,
      blockTag: 'pending',
    })
  })

  it('re-sends the SAME nonce with bumped fees when stuck, returns the mined replacement', async () => {
    const { exec, sendTransaction, bumpFees } = makeHarness({
      bumpQueue: [FEES_B],
      mineAt: { 1: 40 }, // replacement (sent at t=30) mines at t=40
    })
    expect((await exec.send(CALL, { urgent: true })).transactionHash).toBe('0xhash2')
    expect(sendTransaction).toHaveBeenCalledTimes(2)
    const second = sendTransaction.mock.calls[1][0]
    expect(second.nonce).toBe(NONCE)
    expect(second.gas).toBe(GAS)
    expect(second.maxFeePerGas).toBe(FEES_B.maxFeePerGas)
    expect(second.maxPriorityFeePerGas).toBe(FEES_B.maxPriorityFeePerGas)
    expect(bumpFees).toHaveBeenCalledWith(FEES_A, { urgent: true })
  })

  it('resolves to the original when the replacement is rejected with a nonce error (it mined)', async () => {
    const { exec, sendTransaction } = makeHarness({
      bumpQueue: [FEES_B],
      sendErrors: { 1: new Error('nonce too low') },
      mineAt: { 0: 31 }, // original mines right as the replacement is rejected
    })
    expect((await exec.send(CALL)).transactionHash).toBe('0xhash1')
    expect(sendTransaction).toHaveBeenCalledTimes(2)
  })

  it('throws a sanitized error when the nonce was consumed but nothing of ours mined', async () => {
    const { exec } = makeHarness({
      bumpQueue: [FEES_B],
      sendErrors: { 1: new Error('nonce too low') },
      // no mineAt: neither attempt ever gets a receipt
    })
    const err: unknown = await exec.send(CALL).then(
      () => null,
      (e: unknown) => e,
    )
    expect(err).toBeInstanceOf(Error)
    const message = (err as Error).message
    expect(message).toMatch(/external tx/)
    // Like TxNotMinedError: the message must not echo the raw rejection, or
    // runCycle's isNonceError suppression would swallow the alert.
    expect(message).not.toMatch(/nonce too (low|high)|already known/i)
    expect((err as { cause?: unknown }).cause).toBeInstanceOf(Error)
  })

  it("keeps waiting on sent txs when the replacement is 'underpriced'", async () => {
    const { exec } = makeHarness({
      bumpQueue: [FEES_B],
      sendErrors: { 1: new Error('replacement transaction underpriced') },
      mineAt: { 0: 45 },
    })
    expect((await exec.send(CALL)).transactionHash).toBe('0xhash1')
  })

  it('a transient bumpFees failure does not disable bumping', async () => {
    const { exec, sendTransaction } = makeHarness({
      bumpQueue: [new Error('rpc down'), FEES_B],
      mineAt: { 1: 70 }, // replacement (sent on the SECOND bump window) mines
    })
    expect((await exec.send(CALL)).transactionHash).toBe('0xhash2')
    expect(sendTransaction).toHaveBeenCalledTimes(2)
  })

  it('stops bumping at the fee cap and throws TxNotMinedError on budget exhaustion', async () => {
    const { exec, sendTransaction } = makeHarness({ bumpQueue: [null] })
    const err = await exec.send(CALL).catch((e) => e)
    expect(err).toBeInstanceOf(TxNotMinedError)
    expect(err.hashes).toEqual(['0xhash1'])
    expect(err.lastHash).toBe('0xhash1')
    // The message must never look like a transient nonce error, or runCycle's
    // notify suppression would swallow the alert.
    expect(err.message).not.toMatch(/nonce too (low|high)|already known/i)
    expect(sendTransaction).toHaveBeenCalledTimes(1)
  })

  it('forwards urgency to the fee provider', async () => {
    const { exec, fees } = makeHarness({ mineAt: { 0: 5 } })
    await exec.send(CALL, { urgent: true })
    expect(fees).toHaveBeenCalledWith({ urgent: true })
  })
})

describe('RolesExecutor.simulate', () => {
  it('eth_calls the modifier from the bot address', async () => {
    const call = vi.fn().mockResolvedValue({ data: '0x' })
    const exec = createRolesExecutor(makeDeps({ publicClient: { call } as never }))
    await exec.simulate(CALL)
    const arg = call.mock.calls[0][0]
    expect(arg.to).toBe(ROLES_MODIFIER)
    expect(arg.account).toBe(BOT)
    expect(arg.data).toBe(exec.wrapCalldata(CALL))
  })

  it('propagates a revert as a thrown error', async () => {
    const call = vi.fn().mockRejectedValue(new Error('NotAuthorized()'))
    const exec = createRolesExecutor(makeDeps({ publicClient: { call } as never }))
    await expect(exec.simulate(CALL)).rejects.toThrow(/NotAuthorized/)
  })
})

describe('RolesExecutor.preflight', () => {
  it('passes when the modifier is deployed and avatar/target both equal the Safe', async () => {
    const publicClient = {
      getCode: vi.fn().mockResolvedValue('0x60016001'),
      readContract: vi
        .fn()
        .mockResolvedValueOnce([SAFE])
        .mockResolvedValueOnce(SAFE)
        .mockResolvedValueOnce(SAFE),
    }
    const exec = createRolesExecutor(makeDeps({ publicClient: publicClient as never }))
    await expect(exec.preflight()).resolves.toBeUndefined()
    expect(publicClient.getCode).toHaveBeenCalledWith({ address: ROLES_MODIFIER })
  })

  it('throws when the modifier has no bytecode', async () => {
    const publicClient = {
      getCode: vi.fn().mockResolvedValue('0x'),
      readContract: vi.fn().mockResolvedValue([SAFE]),
    }
    const exec = createRolesExecutor(makeDeps({ publicClient: publicClient as never }))
    await expect(exec.preflight()).rejects.toThrow(/no bytecode/)
  })

  it('throws when avatar does not match the Safe', async () => {
    const publicClient = {
      getCode: vi.fn().mockResolvedValue('0x60016001'),
      readContract: vi
        .fn()
        .mockResolvedValueOnce([SAFE])
        .mockResolvedValueOnce('0x9999999999999999999999999999999999999999') // avatar
        .mockResolvedValueOnce(SAFE), // target
    }
    const exec = createRolesExecutor(makeDeps({ publicClient: publicClient as never }))
    await expect(exec.preflight()).rejects.toThrow(/avatar/)
  })

  it('throws before startup when the bot has drifted into the owner set', async () => {
    const publicClient = {
      getCode: vi.fn(),
      readContract: vi.fn().mockResolvedValue([SAFE, BOT]),
    }
    const exec = createRolesExecutor(makeDeps({ publicClient: publicClient as never }))
    await expect(exec.preflight()).rejects.toThrow(/bot .* is an owner/i)
    expect(publicClient.getCode).not.toHaveBeenCalled()
  })
})
