import type { Account, PublicClient } from 'viem'
import { parseEther, parseGwei } from 'viem'
import { describe, expect, it, vi } from 'vitest'

import { createGasPolicy } from './gasPolicy'

const KEEPER = '0x00000000000000000000000000000000000000ea' as `0x${string}`

const CONFIG = {
  MAX_FEE_GWEI: 400,
  MAX_PRIORITY_FEE_GWEI: 2,
  HEDGE_MAX_BASE_FEE_GWEI: 50,
  URGENT_MAX_BASE_FEE_GWEI: 300,
  MIN_KEEPER_BALANCE_ETH: 0.05,
  KEEPER_BALANCE_WARN_ETH: 0.015,
}

function makePolicy(opts: {
  baseFee: bigint | null
  balance?: bigint
  nowMs?: () => number
  /** Network-estimated priority tip; defaults to 0.1 gwei. Set to a rejecting */
  priorityFee?: bigint
  /** thunk (via estimateThrows) to exercise the RPC-failure fallback. */
  estimateThrows?: boolean
}) {
  const notify = vi.fn(async () => undefined)
  const publicClient = {
    getBlock: vi.fn(async () => ({ baseFeePerGas: opts.baseFee })),
    getBalance: vi.fn(async () => opts.balance ?? parseEther('1')),
    estimateMaxPriorityFeePerGas: vi.fn(async () => {
      if (opts.estimateThrows) throw new Error('unsupported method')
      return opts.priorityFee ?? parseGwei('0.1')
    }),
  } as unknown as PublicClient
  const policy = createGasPolicy({
    publicClient,
    account: { address: KEEPER } as Account,
    notifier: { notify },
    config: CONFIG,
    now: opts.nowMs ?? (() => 0),
  })
  return { policy, notify, publicClient }
}

describe('assess — two-tier basefee deferral', () => {
  it('proceeds below the hedge cap', async () => {
    const { policy } = makePolicy({ baseFee: parseGwei('30') })
    const gas = await policy.assess(false)
    expect(gas.proceed).toBe(true)
    expect(gas.baseFeeGwei).toBe(30)
  })

  it('defers a routine hedge above the hedge cap', async () => {
    const { policy } = makePolicy({ baseFee: parseGwei('80') })
    const gas = await policy.assess(false)
    expect(gas.proceed).toBe(false)
    expect(gas.capGwei).toBe(50)
  })

  it('lets an urgent hedge through the same basefee', async () => {
    const { policy } = makePolicy({ baseFee: parseGwei('80') })
    const gas = await policy.assess(true)
    expect(gas.proceed).toBe(true)
    expect(gas.capGwei).toBe(300)
  })

  it('defers even urgent hedges above the urgent cap', async () => {
    const { policy } = makePolicy({ baseFee: parseGwei('350') })
    expect((await policy.assess(true)).proceed).toBe(false)
  })

  it('proceeds on pre-1559 chains (no basefee)', async () => {
    const { policy } = makePolicy({ baseFee: null })
    expect((await policy.assess(false)).proceed).toBe(true)
  })

  it('rate-limits skip alerts to once per streak/cooldown', async () => {
    let t = 0
    const { policy } = makePolicy({ baseFee: parseGwei('80'), nowMs: () => t })
    expect((await policy.assess(false)).shouldNotifySkip).toBe(true)
    t += 60_000 // 1 min later, same streak
    expect((await policy.assess(false)).shouldNotifySkip).toBe(false)
    t += 31 * 60_000 // past the cooldown
    expect((await policy.assess(false)).shouldNotifySkip).toBe(true)
  })

  it('a recovered streak re-arms the skip alert immediately', async () => {
    let base = parseGwei('80')
    let t = 0
    const notify = vi.fn(async () => undefined)
    const publicClient = {
      getBlock: vi.fn(async () => ({ baseFeePerGas: base })),
      getBalance: vi.fn(async () => parseEther('1')),
    } as unknown as PublicClient
    const policy = createGasPolicy({
      publicClient,
      account: { address: KEEPER } as Account,
      notifier: { notify },
      config: CONFIG,
      now: () => t,
    })
    expect((await policy.assess(false)).shouldNotifySkip).toBe(true)
    base = parseGwei('10') // spike over
    await policy.assess(false)
    base = parseGwei('80') // new spike 1 min later — alert again
    t += 60_000
    expect((await policy.assess(false)).shouldNotifySkip).toBe(true)
  })
})

describe('fees — EIP-1559 caps', () => {
  it('uses the estimated tip (below the cap): 2x basefee + tip', async () => {
    const { policy } = makePolicy({ baseFee: parseGwei('30'), priorityFee: parseGwei('0.1') })
    const fees = await policy.fees()
    expect(fees).toEqual({
      maxFeePerGas: parseGwei('60.1'),
      maxPriorityFeePerGas: parseGwei('0.1'),
    })
  })

  it('clamps the tip to MAX_PRIORITY_FEE_GWEI', async () => {
    const { policy } = makePolicy({ baseFee: parseGwei('30'), priorityFee: parseGwei('5') })
    const fees = await policy.fees()
    expect(fees?.maxPriorityFeePerGas).toBe(parseGwei('2'))
  })

  it('falls back to the cap when estimation throws', async () => {
    const { policy } = makePolicy({ baseFee: parseGwei('30'), estimateThrows: true })
    const fees = await policy.fees()
    expect(fees?.maxPriorityFeePerGas).toBe(parseGwei('2'))
  })

  it('hard-clamps maxFeePerGas to MAX_FEE_GWEI', async () => {
    const { policy } = makePolicy({ baseFee: parseGwei('250') })
    const fees = await policy.fees()
    expect(fees?.maxFeePerGas).toBe(parseGwei('400'))
  })

  it('returns undefined on pre-1559 chains', async () => {
    const { policy } = makePolicy({ baseFee: null })
    expect(await policy.fees()).toBeUndefined()
  })
})

describe('checkKeeperBalance', () => {
  it('stays quiet above the minimum', async () => {
    const { policy, notify } = makePolicy({ baseFee: parseGwei('10'), balance: parseEther('1') })
    await policy.checkKeeperBalance()
    expect(notify).not.toHaveBeenCalled()
  })

  it('alerts below the minimum, rate-limited to the cooldown', async () => {
    let t = 0
    const { policy, notify } = makePolicy({
      baseFee: parseGwei('10'),
      balance: parseEther('0.01'),
      nowMs: () => t,
    })
    await policy.checkKeeperBalance()
    expect(notify).toHaveBeenCalledTimes(1)
    t += 60_000
    await policy.checkKeeperBalance()
    expect(notify).toHaveBeenCalledTimes(1) // within cooldown
    t += 7 * 60 * 60_000
    await policy.checkKeeperBalance()
    expect(notify).toHaveBeenCalledTimes(2)
  })
})
