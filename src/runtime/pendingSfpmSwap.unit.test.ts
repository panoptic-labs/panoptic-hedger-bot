import { mkdtempSync } from 'node:fs'
import { tmpdir } from 'node:os'
import path from 'node:path'

import { afterEach, beforeEach, describe, expect, it } from 'vitest'

import { PendingSfpmSwapStore } from './pendingSfpmSwap'

const SAFE = '0x1111111111111111111111111111111111111111'
const POOL = '0x2222222222222222222222222222222222222222'
const SFPM = '0x4444444444444444444444444444444444444444'
const SWAP_POOL = '0x5555555555555555555555555555555555555555'
const DISPATCH_ID = '00000000-0000-4000-8000-000000000001'

describe('PendingSfpmSwapStore', () => {
  beforeEach(() => {
    process.env.HEDGER_PENDING_SFPM_SWAP_PATH = path.join(
      mkdtempSync(path.join(tmpdir(), 'pending-sfpm-')),
      'pending.json',
    )
  })

  afterEach(() => {
    delete process.env.HEDGER_PENDING_SFPM_SWAP_PATH
  })

  it('persists and clears an identity-bound exact-input obligation', () => {
    const first = new PendingSfpmSwapStore({
      chainId: 1,
      safe: SAFE,
      pool: POOL,
      sfpm: SFPM,
      swapPool: SWAP_POOL,
    })
    first.save({ dispatchIntentId: DISPATCH_ID, sellToken0: true, amount: 123n })

    const restarted = new PendingSfpmSwapStore({
      chainId: 1,
      safe: SAFE,
      pool: POOL,
      sfpm: SFPM,
      swapPool: SWAP_POOL,
    })
    expect(restarted.read()).toEqual({
      dispatchIntentId: DISPATCH_ID,
      sellToken0: true,
      amount: 123n,
    })
    restarted.clear()
    expect(restarted.read()).toBeNull()
  })

  it('rejects a pending obligation from a different Safe', () => {
    new PendingSfpmSwapStore({
      chainId: 1,
      safe: SAFE,
      pool: POOL,
      sfpm: SFPM,
      swapPool: SWAP_POOL,
    }).save({
      dispatchIntentId: DISPATCH_ID,
      sellToken0: false,
      amount: 1n,
    })
    expect(() =>
      new PendingSfpmSwapStore({
        chainId: 1,
        safe: '0x3333333333333333333333333333333333333333',
        pool: POOL,
        sfpm: SFPM,
        swapPool: SWAP_POOL,
      }).read(),
    ).toThrow(/identity/)
  })
})
