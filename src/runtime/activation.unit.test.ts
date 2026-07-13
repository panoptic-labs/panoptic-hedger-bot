import { mkdtempSync } from 'node:fs'
import { tmpdir } from 'node:os'
import path from 'node:path'

import { afterEach, beforeEach, describe, expect, it } from 'vitest'

import type { HedgerBotConfig } from '../config'
import { buildActivationMarker, clearActivation, isActivated, writeActivation } from './activation'

const SAFE = '0x00000000000000000000000000000000000000aa' as const
const POOL = '0x00000000000000000000000000000000000000bb' as const

// Only the fields isActivated / buildActivationMarker read.
const config = { CHAIN_ID: 1, SAFE_ADDRESS: SAFE, POOL_ADDRESS: POOL } as unknown as HedgerBotConfig

describe('activation marker', () => {
  beforeEach(() => {
    const dir = mkdtempSync(path.join(tmpdir(), 'hedger-act-'))
    process.env.HEDGER_ACTIVATED_PATH = path.join(dir, '.hedger-activated.json')
  })
  afterEach(() => {
    clearActivation()
    delete process.env.HEDGER_ACTIVATED_PATH
  })

  it('is not activated when no marker exists', () => {
    expect(isActivated(config)).toBe(false)
  })

  it('is activated when the marker matches safe/pool/chain', () => {
    writeActivation(buildActivationMarker(config, true, '2026-01-01T00:00:00Z'))
    expect(isActivated(config)).toBe(true)
  })

  it('is NOT activated when the marker is for a different Safe/pool/chain', () => {
    writeActivation(buildActivationMarker(config, true, '2026-01-01T00:00:00Z'))
    expect(isActivated({ ...config, SAFE_ADDRESS: POOL } as HedgerBotConfig)).toBe(false)
    expect(isActivated({ ...config, POOL_ADDRESS: SAFE } as HedgerBotConfig)).toBe(false)
    expect(isActivated({ ...config, CHAIN_ID: 8453 } as HedgerBotConfig)).toBe(false)
  })

  it('matches case-insensitively on addresses', () => {
    writeActivation(buildActivationMarker(config, true, '2026-01-01T00:00:00Z'))
    expect(isActivated({ ...config, SAFE_ADDRESS: SAFE.toUpperCase() as `0x${string}` })).toBe(true)
  })
})
