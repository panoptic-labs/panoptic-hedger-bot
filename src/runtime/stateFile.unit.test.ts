import { mkdtempSync } from 'node:fs'
import { tmpdir } from 'node:os'
import path from 'node:path'

import { afterEach, beforeEach, describe, expect, it } from 'vitest'

import {
  type RuntimeState,
  clearRuntimeState,
  computeRunning,
  patchRuntimeState,
  readRuntimeState,
  writeRuntimeState,
} from './stateFile'

const base: RuntimeState = {
  pid: process.pid,
  version: '1.2.3',
  startedAt: '2026-01-01T00:00:00Z',
  dryRun: true,
  chainId: 1,
  safe: '0x00000000000000000000000000000000000000aa',
  pool: '0x00000000000000000000000000000000000000bb',
}

describe('runtime state file', () => {
  beforeEach(() => {
    const dir = mkdtempSync(path.join(tmpdir(), 'hedger-rt-'))
    process.env.HEDGER_STATE_PATH = path.join(dir, '.hedger-runtime.json')
  })
  afterEach(() => {
    clearRuntimeState()
    delete process.env.HEDGER_STATE_PATH
  })

  it('round-trips write → read', () => {
    writeRuntimeState(base)
    expect(readRuntimeState()).toEqual(base)
  })

  it('patch merges into existing state and no-ops when none exists', () => {
    patchRuntimeState({ lastPollTrigger: 'poll' }) // no file yet → no-op
    expect(readRuntimeState()).toBeNull()
    writeRuntimeState(base)
    patchRuntimeState({ lastPollAt: '2026-01-01T00:01:00Z', lastPollTrigger: 'poll' })
    expect(readRuntimeState()?.lastPollTrigger).toBe('poll')
    expect(readRuntimeState()?.version).toBe('1.2.3')
  })

  it('clear removes the file', () => {
    writeRuntimeState(base)
    clearRuntimeState()
    expect(readRuntimeState()).toBeNull()
  })
})

describe('computeRunning', () => {
  const nowMs = Date.parse('2026-01-01T00:10:00Z')

  it('not running when no state', () => {
    expect(computeRunning(null, 60_000, nowMs).running).toBe(false)
  })

  it('not running when pid is dead', () => {
    const r = computeRunning(
      { ...base, pid: 2_000_000_000, lastPollAt: '2026-01-01T00:09:50Z' },
      60_000,
      nowMs,
    )
    expect(r.running).toBe(false)
    expect(r.stalled).toBe(false)
  })

  it('running when pid alive and last poll fresh', () => {
    const r = computeRunning({ ...base, lastPollAt: '2026-01-01T00:09:50Z' }, 60_000, nowMs)
    expect(r.running).toBe(true)
  })

  it('stalled when pid alive but last poll is stale', () => {
    const r = computeRunning({ ...base, lastPollAt: '2026-01-01T00:00:00Z' }, 60_000, nowMs)
    expect(r.running).toBe(false)
    expect(r.stalled).toBe(true)
  })

  it('running (first poll pending) when alive with no lastPollAt', () => {
    const r = computeRunning({ ...base }, 60_000, nowMs)
    expect(r.running).toBe(true)
  })
})
