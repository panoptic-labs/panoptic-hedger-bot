import { mkdtempSync, readFileSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import path from 'node:path'

import { afterEach, describe, expect, it } from 'vitest'

import { parseHedgerBotConfig } from '../../src/config'
import { readActivation } from '../../src/runtime/activation'
import { isDeactivated, writeDeactivation } from '../../src/runtime/deactivation'
import {
  buildActivationCandidate,
  buildReadOnlyActivationCandidate,
  persistGuidedActivation,
} from './guidedActivation'

const BASE_ENV = {
  CHAIN_ID: '1',
  RPC_URL: 'https://rpc.example',
  POOL_ADDRESS: '0x1111111111111111111111111111111111111111',
  SAFE_ADDRESS: '0x2222222222222222222222222222222222222222',
  ROLES_MODIFIER_ADDRESS: '0x3333333333333333333333333333333333333333',
  ROLE_KEY: `0x${'11'.repeat(32)}`,
  BOT_PRIVATE_KEY: `0x${'22'.repeat(32)}`,
  ASSET_INDEX: '1',
  DRY_RUN: 'true',
} satisfies NodeJS.ProcessEnv

describe('guided activation candidate', () => {
  afterEach(() => {
    delete process.env.HEDGER_ACTIVATED_PATH
    delete process.env.HEDGER_DISABLED_PATH
  })

  it('keeps SFPM disabled when its authorization surface is not provisioned', () => {
    const candidate = buildActivationCandidate(parseHedgerBotConfig(BASE_ENV), true)
    expect(candidate.DRY_RUN).toBe(false)
    expect(candidate.SFPM_SWAP_ENABLED).toBe(false)
  })

  it('rejects read-only activation when DRY_RUN=true', () => {
    expect(() => buildReadOnlyActivationCandidate(parseHedgerBotConfig(BASE_ENV))).toThrow(
      /requires DRY_RUN=false/,
    )
  })

  it('uses the configured SFPM choice in read-only mode', () => {
    const config = parseHedgerBotConfig({
      ...BASE_ENV,
      DRY_RUN: 'false',
      SFPM_SWAP_PROVISIONED: 'true',
      SFPM_SWAP_ENABLED: 'true',
      SFPM_SWAP_ADDRESS_V3: '0x4444444444444444444444444444444444444444',
      SFPM_SWAP_POOL_ADDRESS: '0x5555555555555555555555555555555555555555',
      MULTISEND_CALL_ONLY_ADDRESS: '0x6666666666666666666666666666666666666666',
      MULTISEND_UNWRAPPER_ADDRESS: '0x7777777777777777777777777777777777777777',
    })
    expect(buildReadOnlyActivationCandidate(config).SFPM_SWAP_ENABLED).toBe(true)
  })

  it('writes the activation marker without mutating env and clears deactivation', () => {
    const directory = mkdtempSync(path.join(tmpdir(), 'container-activation-'))
    const envPath = path.join(directory, 'hedger.env')
    process.env.HEDGER_ACTIVATED_PATH = path.join(directory, '.hedger-activated.json')
    process.env.HEDGER_DISABLED_PATH = path.join(directory, '.hedger-disabled.json')
    writeFileSync(envPath, 'DRY_RUN=false\nSFPM_SWAP_ENABLED=false\n')
    writeDeactivation(new Date('2026-01-01T00:00:00.000Z'))

    persistGuidedActivation({
      marker: {
        schemaVersion: 2,
        policyVersion: 'hedger-bot-policy-v7',
        releaseVersion: 'test',
        activatedAt: '2026-01-02T00:00:00.000Z',
        doctorPassed: true,
        botAddress: '0x1111111111111111111111111111111111111111',
        safeAddress: '0x2222222222222222222222222222222222222222',
        poolAddress: '0x3333333333333333333333333333333333333333',
        policyFingerprint: `0x${'11'.repeat(32)}`,
        codeIdentityFingerprint: `0x${'22'.repeat(32)}`,
        permissionManifestFingerprint: `0x${'33'.repeat(32)}`,
      },
      envPath,
      sfpmEnabled: false,
      readOnlyConfig: true,
    })

    expect(readFileSync(envPath, 'utf8')).toBe('DRY_RUN=false\nSFPM_SWAP_ENABLED=false\n')
    expect(readActivation()?.botAddress).toBe('0x1111111111111111111111111111111111111111')
    expect(isDeactivated()).toBe(false)
  })
})
