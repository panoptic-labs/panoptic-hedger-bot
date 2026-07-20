import { randomUUID } from 'node:crypto'
import { mkdirSync, renameSync, rmdirSync, rmSync } from 'node:fs'
import path from 'node:path'

import type { Address } from 'viem'
import { getAddress } from 'viem'
import { z } from 'zod'

import { runtimeDataPath } from './paths'
import { readSecureJson, removeSecureFile, writeSecureJson } from './secureFile'

const leaseSchema = z
  .object({
    version: z.literal(1),
    instanceId: z.string().uuid(),
    pid: z.number().int().positive(),
    signer: z.string().regex(/^0x[0-9a-fA-F]{40}$/),
    safe: z.string().regex(/^0x[0-9a-fA-F]{40}$/),
    pool: z.string().regex(/^0x[0-9a-fA-F]{40}$/),
    acquiredAt: z.string().datetime(),
    expiresAt: z.string().datetime(),
  })
  .strict()

type LeaseRecord = z.infer<typeof leaseSchema>

export interface InstanceIdentity {
  signer: Address
  safe: Address
  pool: Address
}

export interface InstanceLease {
  readonly instanceId: string
  assertOwned(): void
  renew(): void
  release(): void
}

export interface InstanceLeaseHeartbeat {
  stop(): void
}

function errorCode(error: unknown): string | undefined {
  if (!error || typeof error !== 'object' || !('code' in error)) return undefined
  const code = Reflect.get(error, 'code')
  return typeof code === 'string' ? code : undefined
}

function leaseDirectory(): string {
  return process.env.HEDGER_LEASE_PATH ?? runtimeDataPath('.hedger-instance.lock')
}

function ownerPath(directory = leaseDirectory()): string {
  return path.join(directory, 'owner.json')
}

function readOwner(directory = leaseDirectory()): LeaseRecord {
  const owner = readSecureJson(ownerPath(directory), leaseSchema, {
    maxBytes: 4 * 1024,
    invalid: 'throw',
  })
  if (!owner) throw new Error('instance lease owner is missing')
  return owner
}

function writeOwner(record: LeaseRecord): void {
  writeSecureJson(ownerPath(), leaseSchema, record)
}

function sameIdentity(record: LeaseRecord, identity: InstanceIdentity): boolean {
  return (
    getAddress(record.signer) === getAddress(identity.signer) &&
    getAddress(record.safe) === getAddress(identity.safe) &&
    getAddress(record.pool) === getAddress(identity.pool)
  )
}

export function acquireInstanceLease(
  identity: InstanceIdentity,
  options: { leaseMs?: number; now?: () => number } = {},
): InstanceLease {
  const leaseMs = options.leaseMs ?? 30_000
  const now = options.now ?? Date.now
  const instanceId = randomUUID()
  const acquiredAt = new Date(now()).toISOString()
  const directory = leaseDirectory()

  try {
    mkdirSync(directory, { mode: 0o700 })
  } catch (error) {
    if (errorCode(error) !== 'EEXIST') throw error
    let existing: LeaseRecord
    try {
      existing = readOwner(directory)
    } catch {
      throw new Error('existing instance lease is unreadable; refusing unsafe takeover')
    }
    if (!sameIdentity(existing, identity)) {
      throw new Error('instance lease belongs to another signer/Safe/pool identity')
    }
    if (Date.parse(existing.expiresAt) > now()) {
      throw new Error(`another live hedger instance owns the lease (${existing.instanceId})`)
    }
    const stale = `${directory}.expired-${instanceId}`
    try {
      renameSync(directory, stale)
      mkdirSync(directory, { mode: 0o700 })
    } catch {
      throw new Error('another hedger instance won the expired-lease takeover')
    } finally {
      rmSync(stale, { recursive: true, force: true })
    }
  }

  let record: LeaseRecord = {
    version: 1,
    instanceId,
    pid: process.pid,
    signer: getAddress(identity.signer),
    safe: getAddress(identity.safe),
    pool: getAddress(identity.pool),
    acquiredAt,
    expiresAt: new Date(now() + leaseMs).toISOString(),
  }
  writeOwner(record)

  return {
    instanceId,
    assertOwned() {
      let current: LeaseRecord
      try {
        current = readOwner()
      } catch {
        throw new Error('live-instance fence is unavailable; refusing transaction send')
      }
      if (current.instanceId !== instanceId || Date.parse(current.expiresAt) <= now()) {
        throw new Error('live-instance fence lost or expired; refusing transaction send')
      }
    },
    renew() {
      this.assertOwned()
      record = { ...record, expiresAt: new Date(now() + leaseMs).toISOString() }
      writeOwner(record)
    },
    release() {
      try {
        const current = readOwner()
        if (current.instanceId !== instanceId || current.pid !== process.pid) return
        removeSecureFile(ownerPath())
        rmdirSync(directory)
      } catch {
        // A lost lease belongs to its surviving owner and must not be cleared.
      }
    },
  }
}

/** Keep an acquired lease live until stopped, reporting ownership loss once. */
export function startInstanceLeaseHeartbeat(
  lease: InstanceLease,
  onLost: (error: unknown) => void,
  intervalMs = 10_000,
): InstanceLeaseHeartbeat {
  let stopped = false
  const timer = setInterval(() => {
    if (stopped) return
    try {
      lease.renew()
    } catch (error) {
      stopped = true
      clearInterval(timer)
      onLost(error)
    }
  }, intervalMs)

  return {
    stop() {
      if (stopped) return
      stopped = true
      clearInterval(timer)
    },
  }
}
