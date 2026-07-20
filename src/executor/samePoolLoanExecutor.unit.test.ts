import { panopticPoolV2Abi } from '@panoptic-eng/sdk/v2'
import type { Address, PublicClient } from 'viem'
import { decodeFunctionData } from 'viem'
import { describe, expect, it, vi } from 'vitest'

import type { RolesExecutor } from '../safe/rolesExecutor'
import * as botLogModule from '../utils/log'
import { createSamePoolLoanExecutor, slippageBpsToTickDistance } from './samePoolLoanExecutor'
import type { HedgeContext, HedgeIntent } from './types'

const POOL: Address = '0x2222222222222222222222222222222222222222'
const SAFE: Address = '0x3333333333333333333333333333333333333333'
const PUBLIC_CLIENT = {} as PublicClient
const MIN_TICK = -887272
const MAX_TICK = 887272

function fakeRoles() {
  const receipt = {
    transactionHash: '0xhash',
    status: 'success',
    blockNumber: 1n,
    blockHash: `0x${'ab'.repeat(32)}`,
  } as never
  return {
    wrapCalldata: vi.fn(),
    send: vi.fn().mockResolvedValue(receipt),
    simulate: vi.fn().mockResolvedValue(undefined),
    preflight: vi.fn().mockResolvedValue(undefined),
  } satisfies RolesExecutor
}

function decodeDispatch(data: `0x${string}`) {
  const decoded = decodeFunctionData({ abi: panopticPoolV2Abi, data })
  expect(decoded.functionName).toBe('dispatch')
  const [positionIdList, finalPositionIdList, positionSizes, tickLimits, usePremia, builderCode] =
    decoded.args as unknown as [
      readonly bigint[],
      readonly bigint[],
      readonly bigint[],
      readonly (readonly number[])[],
      boolean,
      bigint,
    ]
  return { positionIdList, finalPositionIdList, positionSizes, tickLimits, usePremia, builderCode }
}

const baseIntent: HedgeIntent = {
  action: 'open',
  openTokenId: 99n,
  openPositionSize: 1000n,
  swapAtMint: true,
  closeTokenIds: [],
  existingPositionIds: [11n, 22n],
  skippedCollidingTokenIds: [],
  currentTick: 100n,
  slippageBps: 30n,
}

describe('slippageBpsToTickDistance', () => {
  it.each([
    [0n, 0n],
    [1n, 1n],
    [30n, 30n],
    [100n, 100n],
    [500n, 488n],
  ])('conservatively converts %s bps to %s ticks', (bps, ticks) => {
    expect(slippageBpsToTickDistance(bps)).toBe(ticks)
  })

  it('rejects values outside the configuration policy', () => {
    expect(() => slippageBpsToTickDistance(-1n)).toThrow(/out of bounds/)
    expect(() => slippageBpsToTickDistance(501n)).toThrow(/out of bounds/)
  })
})

describe('samePoolLoanExecutor.execute — OPEN (mint only)', () => {
  it('encodes a swap dispatch with descending tick limits and sends via roles', async () => {
    const roles = fakeRoles()
    const exec = createSamePoolLoanExecutor({
      poolAddress: POOL,
      publicClient: PUBLIC_CLIENT,
      safeAddress: SAFE,
      rolesExecutor: roles,
      builderCode: 7n,
      dryRun: false,
    })
    const res = await exec.execute(baseIntent)

    expect(roles.send).toHaveBeenCalledTimes(1)
    const call = roles.send.mock.calls[0][0]
    expect(call.to).toBe(POOL)
    const d = decodeDispatch(call.data)
    expect(d.positionIdList).toEqual([99n]) // mint only
    expect(d.finalPositionIdList).toEqual([11n, 22n, 99n]) // existing + mint
    expect(d.positionSizes).toEqual([1000n])
    // swapAtMint=true → descending [tick+slip, tick-slip, 0]
    expect(d.tickLimits).toEqual([[130, 70, 0]])
    expect(d.usePremia).toBe(false)
    expect(d.builderCode).toBe(7n)
    expect(res).toMatchObject({
      transactionHash: '0xhash',
      receipt: { transactionHash: '0xhash', status: 'success' },
      openedTokenId: 99n,
      closedTokenIds: [],
      dryRun: false,
    })
  })
})

describe('samePoolLoanExecutor.execute — FLIP (mint + burns)', () => {
  it('orders burns before mints, zero-sizes burns, applies swap ordering to all', async () => {
    const roles = fakeRoles()
    const exec = createSamePoolLoanExecutor({
      poolAddress: POOL,
      publicClient: PUBLIC_CLIENT,
      safeAddress: SAFE,
      rolesExecutor: roles,
      dryRun: false,
    })
    await exec.execute({
      ...baseIntent,
      action: 'flip',
      openTokenId: 99n,
      openPositionSize: 500n,
      closeTokenIds: [11n],
      existingPositionIds: [11n, 22n],
    })
    const d = decodeDispatch(roles.send.mock.calls[0][0].data)
    expect(d.positionIdList).toEqual([11n, 99n]) // burn then mint
    expect(d.finalPositionIdList).toEqual([22n, 99n]) // 11 removed, 99 added
    expect(d.positionSizes).toEqual([0n, 500n]) // burn size zero
    expect(d.tickLimits).toEqual([
      [130, 70, 0],
      [130, 70, 0],
    ])
  })
})

describe('samePoolLoanExecutor.execute — capacity overlay (no swap)', () => {
  it('uses full-range ascending limits when swapAtMint=false', async () => {
    const roles = fakeRoles()
    const exec = createSamePoolLoanExecutor({
      poolAddress: POOL,
      publicClient: PUBLIC_CLIENT,
      safeAddress: SAFE,
      rolesExecutor: roles,
      dryRun: false,
    })
    await exec.execute({
      ...baseIntent,
      action: 'consolidate',
      swapAtMint: false,
      openTokenId: 99n,
      openPositionSize: 500n,
      closeTokenIds: [11n, 22n],
    })
    const d = decodeDispatch(roles.send.mock.calls[0][0].data)
    expect(d.tickLimits).toEqual([
      [MIN_TICK, MAX_TICK, 0],
      [MIN_TICK, MAX_TICK, 0],
      [MIN_TICK, MAX_TICK, 0],
    ])
  })
})

describe('samePoolLoanExecutor.previewFinalState — failure diagnostics', () => {
  it('logs pre/post positionIdList and unredacted calldata when the simulation fails', async () => {
    const roles = fakeRoles()
    // Bare client: the batch args encode fine (valid burn + mint), so the on-chain
    // simulation is attempted and fails against the stub — the same shape as the
    // production InputListFail, where the multicall reaches the pool and reverts.
    const client = {
      getBlockNumber: vi.fn().mockResolvedValue(1n),
      getBlock: vi.fn().mockResolvedValue({
        number: 1n,
        timestamp: 1n,
        hash: `0x${'ab'.repeat(32)}`,
      }),
    } as unknown as PublicClient
    const exec = createSamePoolLoanExecutor({
      poolAddress: POOL,
      publicClient: client,
      safeAddress: SAFE,
      rolesExecutor: roles,
      dryRun: true,
    })

    const botLogSpy = vi.spyOn(botLogModule, 'botLog').mockImplementation(() => {})
    const consoleSpy = vi.spyOn(console, 'log').mockImplementation(() => {})
    try {
      const result = await exec.previewFinalState(
        {
          ...baseIntent,
          action: 'flip',
          openTokenId: 99n,
          openPositionSize: 500n,
          closeTokenIds: [11n],
          existingPositionIds: [11n, 22n],
        },
        1n,
      )
      expect(result.success).toBe(false)
      const logged = botLogSpy.mock.calls.map((c) => String(c[0])).join('\n')
      expect(logged).toContain('pre-hedge positionIdList   = [11, 22]')
      expect(logged).toContain('post-hedge finalPositionIdList = [22, 99]') // 11 burned, 99 minted
      const consoleLogged = consoleSpy.mock.calls.map((c) => String(c[0])).join('\n')
      expect(consoleLogged).toContain('dispatch calldata = 0x')
    } finally {
      botLogSpy.mockRestore()
      consoleSpy.mockRestore()
    }
  })
})

describe('samePoolLoanExecutor.execute — urgency threading', () => {
  const urgentCtx: HedgeContext = { urgent: true }

  it('forwards ctx.urgent to rolesExecutor.send', async () => {
    const roles = fakeRoles()
    const exec = createSamePoolLoanExecutor({
      poolAddress: POOL,
      publicClient: PUBLIC_CLIENT,
      safeAddress: SAFE,
      rolesExecutor: roles,
      dryRun: false,
    })
    await exec.execute(baseIntent, urgentCtx)
    expect(roles.send.mock.calls[0][1]).toEqual({ urgent: true })
  })

  it('sends non-urgent when no context is given', async () => {
    const roles = fakeRoles()
    const exec = createSamePoolLoanExecutor({
      poolAddress: POOL,
      publicClient: PUBLIC_CLIENT,
      safeAddress: SAFE,
      rolesExecutor: roles,
      dryRun: false,
    })
    await exec.execute(baseIntent)
    expect(roles.send.mock.calls[0][1]).toEqual({ urgent: undefined })
  })
})

describe('samePoolLoanExecutor.execute — dry run and noop', () => {
  it('simulates instead of sending when dryRun', async () => {
    const roles = fakeRoles()
    const exec = createSamePoolLoanExecutor({
      poolAddress: POOL,
      publicClient: PUBLIC_CLIENT,
      safeAddress: SAFE,
      rolesExecutor: roles,
      dryRun: true,
    })
    const res = await exec.execute(baseIntent)
    expect(roles.simulate).toHaveBeenCalledTimes(1)
    expect(roles.send).not.toHaveBeenCalled()
    expect(res.dryRun).toBe(true)
  })

  it('does nothing for action none', async () => {
    const roles = fakeRoles()
    const exec = createSamePoolLoanExecutor({
      poolAddress: POOL,
      publicClient: PUBLIC_CLIENT,
      safeAddress: SAFE,
      rolesExecutor: roles,
      dryRun: false,
    })
    const res = await exec.execute({
      ...baseIntent,
      action: 'none',
      openTokenId: null,
      openPositionSize: null,
      closeTokenIds: [],
    })
    expect(roles.send).not.toHaveBeenCalled()
    expect(roles.simulate).not.toHaveBeenCalled()
    expect(res).toMatchObject({
      transactionHash: null,
      receipt: null,
      openedTokenId: null,
      closedTokenIds: [],
    })
  })
})
