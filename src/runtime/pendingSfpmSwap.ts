import type { Address } from 'viem'
import { getAddress } from 'viem'
import { z } from 'zod'

import { runtimeDataPath } from './paths'
import { readSecureJson, removeSecureFile, writeSecureJson } from './secureFile'

const addressSchema = z.string().regex(/^0x[0-9a-fA-F]{40}$/)
const idSchema = z.string().uuid()
const MAX_UINT256 = (1n << 256n) - 1n
const pendingSchema = z
  .object({
    version: z.literal(1),
    chainId: z.number().int().positive(),
    safe: addressSchema,
    pool: addressSchema,
    sfpm: addressSchema,
    swapPool: addressSchema,
    dispatchIntentId: idSchema,
    swapIntentId: idSchema.optional(),
    sellToken0: z.boolean(),
    amount: z
      .string()
      .max(78)
      .regex(/^[1-9]\d*$/)
      .refine((value) => BigInt(value) <= MAX_UINT256, 'amount exceeds uint256'),
    createdAt: z.string().datetime(),
  })
  .strict()

type PendingFile = z.infer<typeof pendingSchema>

export interface PendingSfpmSwap {
  dispatchIntentId: string
  swapIntentId?: string
  sellToken0: boolean
  amount: bigint
}

export interface PendingSfpmSwapPort {
  read(): PendingSfpmSwap | null
  save(pending: PendingSfpmSwap): void
  clear(): void
}

export function pendingSfpmSwapPath(): string {
  return (
    process.env.HEDGER_PENDING_SFPM_SWAP_PATH ?? runtimeDataPath('.hedger-pending-sfpm-swap.json')
  )
}

/** Durable identity-bound obligation created before an off-venue dispatch. */
export class PendingSfpmSwapStore implements PendingSfpmSwapPort {
  private readonly identity: {
    chainId: number
    safe: Address
    pool: Address
    sfpm?: Address
    swapPool?: Address
  }

  constructor(identity: {
    chainId: number
    safe: Address
    pool: Address
    sfpm?: Address
    swapPool?: Address
  }) {
    this.identity = {
      chainId: identity.chainId,
      safe: getAddress(identity.safe),
      pool: getAddress(identity.pool),
      sfpm: identity.sfpm === undefined ? undefined : getAddress(identity.sfpm),
      swapPool: identity.swapPool === undefined ? undefined : getAddress(identity.swapPool),
    }
  }

  read(): PendingSfpmSwap | null {
    const existing = readSecureJson(pendingSfpmSwapPath(), pendingSchema, {
      maxBytes: 16_384,
      invalid: 'throw',
    })
    if (existing === null) return null
    this.assertIdentity(existing)
    return {
      dispatchIntentId: existing.dispatchIntentId,
      swapIntentId: existing.swapIntentId,
      sellToken0: existing.sellToken0,
      amount: BigInt(existing.amount),
    }
  }

  save(pending: PendingSfpmSwap): void {
    if (this.identity.sfpm === undefined || this.identity.swapPool === undefined) {
      throw new Error('cannot persist an SFPM swap without a configured venue identity')
    }
    if (pending.amount <= 0n || pending.amount > MAX_UINT256) {
      throw new Error('pending SFPM swap amount must be a positive uint256')
    }
    const value: PendingFile = {
      version: 1,
      chainId: this.identity.chainId,
      safe: this.identity.safe,
      pool: this.identity.pool,
      sfpm: this.identity.sfpm,
      swapPool: this.identity.swapPool,
      dispatchIntentId: pending.dispatchIntentId,
      swapIntentId: pending.swapIntentId,
      sellToken0: pending.sellToken0,
      amount: pending.amount.toString(),
      createdAt: new Date().toISOString(),
    }
    writeSecureJson(pendingSfpmSwapPath(), pendingSchema, value)
  }

  clear(): void {
    removeSecureFile(pendingSfpmSwapPath())
  }

  private assertIdentity(existing: PendingFile): void {
    if (
      existing.chainId !== this.identity.chainId ||
      getAddress(existing.safe) !== this.identity.safe ||
      getAddress(existing.pool) !== this.identity.pool ||
      this.identity.sfpm === undefined ||
      getAddress(existing.sfpm) !== this.identity.sfpm ||
      this.identity.swapPool === undefined ||
      getAddress(existing.swapPool) !== this.identity.swapPool
    ) {
      throw new Error('pending SFPM swap identity does not match Safe/pool configuration')
    }
  }
}
