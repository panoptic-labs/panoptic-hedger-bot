import type * as PanopticV2Module from '@panoptic-eng/sdk/v2'
import { panopticPoolV2Abi, simulateWithTokenFlow } from '@panoptic-eng/sdk/v2'
import type { Address, PublicClient } from 'viem'
import { decodeFunctionData } from 'viem'
import { describe, expect, it, vi } from 'vitest'

import type { RolesExecutor } from '../safe/rolesExecutor'
import * as botLogModule from '../utils/log'
import { createSamePoolLoanExecutor, slippageBpsToTickDistance } from './samePoolLoanExecutor'
import type { HedgeContext, HedgeIntent } from './types'

vi.mock('@panoptic-eng/sdk/v2', async (importOriginal) => {
  const actual = await importOriginal<typeof PanopticV2Module>()
  return { ...actual, simulateWithTokenFlow: vi.fn() }
})

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
    // 1000 is the raised ceiling (emergency deleverage band); 1001 is out.
    expect(() => slippageBpsToTickDistance(1001n)).toThrow(/out of bounds/)
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

describe('samePoolLoanExecutor.executeOffVenue — replacement hedge', () => {
  it('orders the no-swap mint before burns so borrowed tokens can fund repayment', async () => {
    const roles = fakeRoles()
    const exec = createSamePoolLoanExecutor({
      poolAddress: POOL,
      publicClient: PUBLIC_CLIENT,
      safeAddress: SAFE,
      rolesExecutor: roles,
      dryRun: false,
    })
    await exec.executeOffVenue({
      ...baseIntent,
      action: 'shrink',
      openTokenId: 99n,
      openPositionSize: 500n,
      closeTokenIds: [11n, 22n],
    })
    const d = decodeDispatch(roles.send.mock.calls[0][0].data)
    expect(d.positionIdList).toEqual([99n, 11n, 22n])
    expect(d.positionSizes).toEqual([500n, 0n, 0n])
    expect(d.tickLimits).toEqual([
      [MIN_TICK, MAX_TICK, 0],
      [MIN_TICK, MAX_TICK, 0],
      [MIN_TICK, MAX_TICK, 0],
    ])
  })
})

describe('samePoolLoanExecutor.executeCollateralSwap — credit exact input', () => {
  it('opens and closes a credit with the swap tick order in one dispatch', async () => {
    const roles = fakeRoles()
    const exec = createSamePoolLoanExecutor({
      poolAddress: POOL,
      publicClient: PUBLIC_CLIENT,
      safeAddress: SAFE,
      rolesExecutor: roles,
      builderCode: 7n,
      dryRun: false,
    })
    const request = {
      kind: 'exactIn' as const,
      tokenType: 1 as const,
      amountIn: 200_000_000n,
      existingPositionIds: [11n, 22n],
      poolId: 1n,
      tickSpacing: 10n,
      currentTick: 100n,
      slippageBps: 30n,
    }

    const result = await exec.executeCollateralSwap?.(request)

    expect(roles.send).toHaveBeenCalledTimes(1)
    const decoded = decodeDispatch(roles.send.mock.calls[0][0].data)
    expect(decoded.positionIdList).toHaveLength(2)
    expect(decoded.positionIdList[0]).toBe(decoded.positionIdList[1])
    expect(decoded.finalPositionIdList).toEqual([11n, 22n])
    expect(decoded.positionSizes).toEqual([200_000_000n, 0n])
    expect(decoded.tickLimits).toEqual([
      [70, 130, 0],
      [130, 70, 0],
    ])
    expect(result).toMatchObject({
      transactionHash: '0xhash',
      amountIn: 200_000_000n,
      dryRun: false,
    })
  })

  it('encodes exact-out with a descending swap mint and reports caller-provided input', async () => {
    const roles = fakeRoles()
    const exec = createSamePoolLoanExecutor({
      poolAddress: POOL,
      publicClient: PUBLIC_CLIENT,
      safeAddress: SAFE,
      rolesExecutor: roles,
      dryRun: false,
    })

    const result = await exec.executeCollateralSwap?.({
      kind: 'exactOut',
      tokenType: 1,
      amountOut: 100n,
      amountIn: 55n,
      existingPositionIds: [11n, 22n],
      poolId: 1n,
      tickSpacing: 10n,
      currentTick: 100n,
      slippageBps: 30n,
    })

    const decoded = decodeDispatch(roles.send.mock.calls[0][0].data)
    expect(decoded.tickLimits).toEqual([
      [130, 70, 0],
      [70, 130, 0],
    ])
    expect(result?.amountIn).toBe(55n)
  })

  it.each([
    {
      request: { kind: 'exactIn' as const, tokenType: 1 as const, amountIn: 40n },
      delta0: 25n,
      delta1: -40n,
      expected: { amountIn: 40n, amountOut: 25n },
    },
    {
      request: { kind: 'exactOut' as const, tokenType: 1 as const, amountOut: 30n },
      delta0: -50n,
      delta1: 30n,
      expected: { amountIn: 50n, amountOut: 30n },
    },
  ])('maps token-flow deltas for $request.kind', async ({ request, delta0, delta1, expected }) => {
    vi.mocked(simulateWithTokenFlow).mockResolvedValueOnce({
      success: true,
      tokenFlow: { delta0, delta1 },
    } as never)
    const exec = createSamePoolLoanExecutor({
      poolAddress: POOL,
      publicClient: PUBLIC_CLIENT,
      safeAddress: SAFE,
      rolesExecutor: fakeRoles(),
      dryRun: false,
    })

    await expect(
      exec.simulateCollateralSwap?.({
        ...request,
        existingPositionIds: [],
        poolId: 1n,
        tickSpacing: 10n,
        currentTick: 100n,
        slippageBps: 30n,
      }),
    ).resolves.toEqual(expected)
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
