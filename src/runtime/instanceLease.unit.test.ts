import { mkdtempSync, readdirSync } from 'node:fs'
import { tmpdir } from 'node:os'
import path from 'node:path'

import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'

import { acquireInstanceLease, startInstanceLeaseHeartbeat } from './instanceLease'

const identity = {
  signer: '0x1111111111111111111111111111111111111111' as const,
  safe: '0x2222222222222222222222222222222222222222' as const,
  pool: '0x3333333333333333333333333333333333333333' as const,
}

describe('instance lease', () => {
  let now: number

  beforeEach(() => {
    now = Date.parse('2026-01-01T00:00:00Z')
    process.env.HEDGER_LEASE_PATH = path.join(
      mkdtempSync(path.join(tmpdir(), 'hedger-lease-')),
      'lease',
    )
  })

  afterEach(() => {
    vi.useRealTimers()
    delete process.env.HEDGER_LEASE_PATH
  })

  it('allows exactly one owner and preserves it when the duplicate releases', () => {
    const owner = acquireInstanceLease(identity, { now: () => now })
    expect(() => acquireInstanceLease(identity, { now: () => now })).toThrow(/another live/)
    owner.assertOwned()
    owner.release()
    expect(() => acquireInstanceLease(identity, { now: () => now })).not.toThrow()
  })

  it('fences an expired owner after takeover', () => {
    const oldOwner = acquireInstanceLease(identity, { leaseMs: 100, now: () => now })
    now += 101
    const newOwner = acquireInstanceLease(identity, { leaseMs: 100, now: () => now })

    const leasePath = process.env.HEDGER_LEASE_PATH
    expect(leasePath).toBeDefined()
    expect(
      readdirSync(path.dirname(leasePath ?? '')).filter((name) => name.includes('.expired-')),
    ).toEqual([])

    expect(() => oldOwner.assertOwned()).toThrow(/lost or expired/)
    expect(() => newOwner.assertOwned()).not.toThrow()
    oldOwner.release()
    expect(() => newOwner.assertOwned()).not.toThrow()
  })

  it('renewal keeps the current owner live', () => {
    const owner = acquireInstanceLease(identity, { leaseMs: 100, now: () => now })
    now += 90
    owner.renew()
    now += 90
    expect(() => owner.assertOwned()).not.toThrow()
  })

  it('keeps the lease live while startup work exceeds the lease lifetime', async () => {
    vi.useFakeTimers({ now })
    const owner = acquireInstanceLease(identity, { leaseMs: 30_000 })
    const onLost = vi.fn()
    const heartbeat = startInstanceLeaseHeartbeat(owner, onLost, 10_000)

    await vi.advanceTimersByTimeAsync(40_000)

    expect(onLost).not.toHaveBeenCalled()
    expect(() => owner.assertOwned()).not.toThrow()
    heartbeat.stop()
    owner.release()
  })
})
