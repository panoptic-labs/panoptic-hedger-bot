import { describe, expect, it, vi } from 'vitest'

import type { SfpmSwapExecutionResult } from '../executor/sfpmSwapExecutor'
import type { HedgeExecutionResult, HedgeExecutor, HedgeIntent } from '../executor/types'
import { type SfpmSwapExecutorLike, executeHedgeWithSfpmVenue } from './executeWithVenue'

const intent: HedgeIntent = {
  action: 'open',
  openTokenId: 0x2000a0488e6a0c2ddn,
  openPositionSize: 1_000n,
  swapAtMint: true, // the coordinator must override this to false for tx1
  closeTokenIds: [],
  existingPositionIds: [],
  skippedCollidingTokenIds: [],
  currentTick: 201042n,
  slippageBps: 50n,
}

function dispatchResult(overrides: Partial<HedgeExecutionResult> = {}): HedgeExecutionResult {
  return {
    transactionHash: '0xd15da7c4',
    receipt: null,
    openedTokenId: intent.openTokenId,
    closedTokenIds: [],
    dryRun: false,
    ...overrides,
  }
}

function swapResult(): SfpmSwapExecutionResult {
  return {
    transactionHash: '0x5a',
    receipt: { status: 'success', transactionHash: '0x5a' } as never,
    amountIn: 500n,
    amountOut: 490n,
    dryRun: false,
  }
}

function makeDispatch(result: HedgeExecutionResult): HedgeExecutor {
  return {
    kind: 'same-pool-loan',
    execute: vi.fn(async () => result),
    executeOffVenue: vi.fn(async () => result),
    previewFinalState: vi.fn(),
  }
}

describe('executeHedgeWithSfpmVenue', () => {
  it('uses the executor off-venue dispatch path for tx1', async () => {
    const dispatchExecutor = makeDispatch(dispatchResult())
    const sfpmExecutor: SfpmSwapExecutorLike = {
      execute: vi.fn(async () => swapResult()),
      simulate: vi.fn(async () => undefined),
    }
    await executeHedgeWithSfpmVenue({
      dispatchExecutor,
      sfpmExecutor,
      intent,
      sellToken0: false,
      swapAmount: 500n,
      expectedAmountOut: 490n,
      swapPoolTick: 201042,
    })
    expect(dispatchExecutor.execute).not.toHaveBeenCalled()
    expect(dispatchExecutor.executeOffVenue).toHaveBeenCalledWith(intent, undefined)
  })

  it('runs both txs and reports neutralized on success', async () => {
    const sfpm = vi.fn(async () => swapResult())
    const res = await executeHedgeWithSfpmVenue({
      dispatchExecutor: makeDispatch(dispatchResult()),
      sfpmExecutor: { execute: sfpm, simulate: vi.fn(async () => undefined) },
      intent,
      sellToken0: false,
      swapAmount: 500n,
      expectedAmountOut: 490n,
      swapPoolTick: 201042,
    })
    expect(sfpm).toHaveBeenCalledWith({
      sellToken0: false,
      kind: 'exactIn',
      amount: 500n,
      expectedAmountOut: 490n,
      currentTick: 201042,
      positionIdList: [intent.openTokenId],
    })
    expect(res.neutralized).toBe(true)
    expect(res.swap).not.toBeNull()
  })

  it('crosses the durable dispatch boundary before sending tx2', async () => {
    const order: string[] = []
    const dispatchExecutor = makeDispatch(dispatchResult())
    vi.mocked(dispatchExecutor.executeOffVenue).mockImplementationOnce(async () => {
      order.push('dispatch')
      return dispatchResult()
    })
    await executeHedgeWithSfpmVenue({
      dispatchExecutor,
      sfpmExecutor: {
        execute: vi.fn(async () => {
          order.push('swap')
          return swapResult()
        }),
        simulate: vi.fn(async () => undefined),
      },
      intent,
      sellToken0: false,
      swapAmount: 500n,
      expectedAmountOut: 490n,
      swapPoolTick: 201042,
      afterDispatch: () => {
        order.push('journal-boundary')
      },
    })

    expect(order).toEqual(['dispatch', 'journal-boundary', 'swap'])
  })

  it('skips the swap for a dry-run dispatch (nothing moved)', async () => {
    const sfpm = vi.fn(async () => swapResult())
    const afterDispatch = vi.fn()
    const res = await executeHedgeWithSfpmVenue({
      dispatchExecutor: makeDispatch(dispatchResult({ dryRun: true, transactionHash: null })),
      sfpmExecutor: { execute: sfpm, simulate: vi.fn(async () => undefined) },
      intent,
      sellToken0: false,
      swapAmount: 500n,
      expectedAmountOut: 490n,
      swapPoolTick: 201042,
      afterDispatch,
    })
    expect(sfpm).not.toHaveBeenCalled()
    expect(afterDispatch).not.toHaveBeenCalled()
    expect(res.neutralized).toBe(true)
  })

  it('flags NOT neutralized when tx2 fails after tx1 lands', async () => {
    const res = await executeHedgeWithSfpmVenue({
      dispatchExecutor: makeDispatch(dispatchResult()),
      sfpmExecutor: {
        execute: vi.fn(async () => {
          throw new Error('PriceBoundFail')
        }),
        simulate: vi.fn(async () => undefined),
      },
      intent,
      sellToken0: false,
      swapAmount: 500n,
      expectedAmountOut: 490n,
      swapPoolTick: 201042,
    })
    expect(res.neutralized).toBe(false)
    expect(res.swap).toBeNull()
    expect((res.swapError as Error).message).toBe('PriceBoundFail')
    // tx1 still landed — the caller keeps the dispatch result for journaling.
    expect(res.dispatch.transactionHash).toBe('0xd15da7c4')
  })
})
