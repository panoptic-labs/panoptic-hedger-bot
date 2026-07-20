import { mkdtempSync } from 'node:fs'
import { tmpdir } from 'node:os'
import path from 'node:path'

import { afterEach, beforeEach, describe, expect, it } from 'vitest'

import {
  assertTradingEnabled,
  clearDeactivation,
  isDeactivated,
  writeDeactivation,
} from './deactivation'

describe('emergency deactivation', () => {
  beforeEach(() => {
    process.env.HEDGER_DISABLED_PATH = path.join(
      mkdtempSync(path.join(tmpdir(), 'hedger-disabled-')),
      'disabled.json',
    )
  })

  afterEach(() => {
    clearDeactivation()
    delete process.env.HEDGER_DISABLED_PATH
  })

  it('changes the immediate pre-send assertion from allow to deny', () => {
    expect(() => assertTradingEnabled()).not.toThrow()
    writeDeactivation(new Date('2026-01-01T00:00:00Z'))
    expect(isDeactivated()).toBe(true)
    expect(() => assertTradingEnabled()).toThrow(/deactivation is active/)
  })

  it('fails closed for a malformed kill-state file', () => {
    writeDeactivation()
    expect(isDeactivated()).toBe(true)
  })
})
