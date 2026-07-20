import type { Address, PublicClient } from 'viem'
import { describe, expect, it, vi } from 'vitest'

import {
  assertBotIsNotSafeOwner,
  assertPlannedSafeOwnerIsNotBot,
  BotIsSafeOwnerError,
  PlannedBotSafeOwnerError,
} from './safeOwnerInvariant'

const SAFE: Address = '0x1111111111111111111111111111111111111111'
const BOT: Address = '0x2222222222222222222222222222222222222222'
const OWNER: Address = '0x3333333333333333333333333333333333333333'

function clientWithOwners(owners: readonly Address[]): PublicClient {
  return { readContract: vi.fn().mockResolvedValue(owners) } as unknown as PublicClient
}

describe('Safe owner invariant', () => {
  it('accepts an owner set that excludes the bot', async () => {
    await expect(assertBotIsNotSafeOwner(clientWithOwners([OWNER]), SAFE, BOT)).resolves.toEqual([
      OWNER,
    ])
  })

  it('fails closed when the current owner set contains the bot', async () => {
    await expect(
      assertBotIsNotSafeOwner(clientWithOwners([OWNER, BOT]), SAFE, BOT),
    ).rejects.toBeInstanceOf(BotIsSafeOwnerError)
  })

  it('propagates an owner-read failure', async () => {
    const publicClient = {
      readContract: vi.fn().mockRejectedValue(new Error('synthetic RPC failure')),
    } as unknown as PublicClient
    await expect(assertBotIsNotSafeOwner(publicClient, SAFE, BOT)).rejects.toThrow(
      'synthetic RPC failure',
    )
  })

  it('rejects a planned final owner that is the bot', () => {
    expect(() => assertPlannedSafeOwnerIsNotBot(BOT, BOT)).toThrow(PlannedBotSafeOwnerError)
    expect(() => assertPlannedSafeOwnerIsNotBot(BOT, BOT)).toThrow(
      /planned setup would make bot .* a Safe owner/,
    )
    expect(() => assertPlannedSafeOwnerIsNotBot(OWNER, BOT)).not.toThrow()
  })
})
