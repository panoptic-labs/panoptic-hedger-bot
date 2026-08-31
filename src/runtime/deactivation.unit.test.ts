import { chmodSync, mkdtempSync } from 'node:fs'
import { tmpdir } from 'node:os'
import path from 'node:path'

import { afterEach, beforeEach, describe, expect, it } from 'vitest'

import { type ActivationMarker, readActivation, writeActivation } from './activation'
import {
  assertTradingEnabled,
  clearDeactivation,
  deactivateRuntime,
  isDeactivated,
  writeDeactivation,
} from './deactivation'

const ACTIVATION_MARKER = {
  schemaVersion: 2,
  policyVersion: 'hedger-bot-policy-v7',
  releaseVersion: 'test',
  activatedAt: '2026-01-01T00:00:00.000Z',
  doctorPassed: true,
  botAddress: '0x1111111111111111111111111111111111111111',
  safeAddress: '0x2222222222222222222222222222222222222222',
  poolAddress: '0x3333333333333333333333333333333333333333',
  policyFingerprint: `0x${'11'.repeat(32)}`,
  codeIdentityFingerprint: `0x${'22'.repeat(32)}`,
  permissionManifestFingerprint: `0x${'33'.repeat(32)}`,
} satisfies ActivationMarker

describe('emergency deactivation', () => {
  let disabledDirectory = ''

  beforeEach(() => {
    disabledDirectory = mkdtempSync(path.join(tmpdir(), 'hedger-disabled-'))
    process.env.HEDGER_DISABLED_PATH = path.join(disabledDirectory, 'disabled.json')
  })

  afterEach(() => {
    chmodSync(disabledDirectory, 0o700)
    clearDeactivation()
    delete process.env.HEDGER_DISABLED_PATH
    delete process.env.HEDGER_ACTIVATED_PATH
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

  it('removes activation only after persisting the kill switch', () => {
    process.env.HEDGER_ACTIVATED_PATH = path.join(
      mkdtempSync(path.join(tmpdir(), 'hedger-activated-')),
      'activated.json',
    )
    writeActivation(ACTIVATION_MARKER)

    deactivateRuntime(new Date('2026-01-02T00:00:00.000Z'))

    expect(isDeactivated()).toBe(true)
    expect(readActivation()).toBeNull()
  })

  it('preserves activation when kill-switch persistence fails', () => {
    process.env.HEDGER_ACTIVATED_PATH = path.join(
      mkdtempSync(path.join(tmpdir(), 'hedger-activated-')),
      'activated.json',
    )
    writeActivation(ACTIVATION_MARKER)
    chmodSync(disabledDirectory, 0o500)

    try {
      expect(() => deactivateRuntime(new Date('2026-01-02T00:00:00.000Z'))).toThrow()
      expect(readActivation()).toEqual(ACTIVATION_MARKER)
    } finally {
      chmodSync(disabledDirectory, 0o700)
    }
  })
})
