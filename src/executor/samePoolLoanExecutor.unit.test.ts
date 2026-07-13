import { panopticPoolV2Abi } from '@panoptic-eng/sdk/v2'
import type { Address } from 'viem'
import { decodeFunctionData } from 'viem'
import { describe, expect, it, vi } from 'vitest'

import type { RolesExecutor } from '../safe/rolesExecutor'
import { createSamePoolLoanExecutor } from './samePoolLoanExecutor'
import type { HedgeIntent } from './types'

const POOL: Address = '0x2222222222222222222222222222222222222222'
const MIN_TICK = -887272
const MAX_TICK = 887272

function fakeRoles() {
  return {
    wrapCalldata: vi.fn(),
    send: vi.fn().mockResolvedValue('0xhash'),
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
  currentTick: 100n,
  slippageBps: 30n,
}

describe('samePoolLoanExecutor.execute — OPEN (mint only)', () => {
  it('encodes a swap dispatch with descending tick limits and sends via roles', async () => {
    const roles = fakeRoles()
    const exec = createSamePoolLoanExecutor({
      poolAddress: POOL,
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
      txHashes: ['0xhash'],
      openedTokenId: 99n,
      closedTokenIds: [],
      dryRun: false,
    })
  })
})

describe('samePoolLoanExecutor.execute — FLIP (mint + burns)', () => {
  it('orders mints before burns, zero-sizes burns, applies swap ordering to all', async () => {
    const roles = fakeRoles()
    const exec = createSamePoolLoanExecutor({
      poolAddress: POOL,
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
    expect(d.positionIdList).toEqual([99n, 11n]) // mint then burn
    expect(d.finalPositionIdList).toEqual([22n, 99n]) // 11 removed, 99 added
    expect(d.positionSizes).toEqual([500n, 0n]) // burn size zero
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

describe('samePoolLoanExecutor.execute — dry run and noop', () => {
  it('simulates instead of sending when dryRun', async () => {
    const roles = fakeRoles()
    const exec = createSamePoolLoanExecutor({
      poolAddress: POOL,
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
    expect(res).toMatchObject({ txHashes: [], openedTokenId: null, closedTokenIds: [] })
  })
})
