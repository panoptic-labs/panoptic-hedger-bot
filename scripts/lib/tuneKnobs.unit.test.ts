import { describe, expect, it } from 'vitest'

import { parseHedgerBotConfig } from '../../src/config'
import { diffTuneAnswers, dotenvObject, TUNE_KNOBS } from './tuneKnobs'

const BASE_ENV: NodeJS.ProcessEnv = {
  CHAIN_ID: '1',
  RPC_URL: 'https://example.invalid/rpc',
  POOL_ADDRESS: `0x${'11'.repeat(20)}`,
  SAFE_ADDRESS: `0x${'22'.repeat(20)}`,
  ROLES_MODIFIER_ADDRESS: `0x${'33'.repeat(20)}`,
  ROLE_KEY: `0x${'44'.repeat(32)}`,
  BOT_PRIVATE_KEY: `0x${'55'.repeat(32)}`,
  ASSET_INDEX: '0',
}

describe('TUNE_KNOBS', () => {
  it('every knob renders the current effective value round-trippably through the schema', () => {
    const cfg = parseHedgerBotConfig(BASE_ENV)
    for (const knob of TUNE_KNOBS.filter((k) => k.applies?.(cfg) ?? true)) {
      const current = knob.current(cfg)
      // Feeding the rendered current value back must parse to the same config —
      // proves the display format matches the env encoding (esp. gwei knobs).
      const reparsed = parseHedgerBotConfig({ ...BASE_ENV, [knob.key]: current })
      expect(knob.current(reparsed), knob.key).toBe(current)
    }
  })

  it('gwei knobs render in gwei (the .env unit), not wei', () => {
    const cfg = parseHedgerBotConfig({ ...BASE_ENV, HEDGE_MAX_BASE_FEE_GWEI: '50' })
    const knob = TUNE_KNOBS.find((k) => k.key === 'HEDGE_MAX_BASE_FEE_GWEI')
    expect(knob?.current(cfg)).toBe('50')
  })

  it('gates SFPM and deleverager knobs on their feature flags', () => {
    const off = parseHedgerBotConfig(BASE_ENV)
    const on = parseHedgerBotConfig({
      ...BASE_ENV,
      SFPM_SWAP_PROVISIONED: 'true',
      SFPM_SWAP_ADDRESS_V3: `0x${'66'.repeat(20)}`,
      SFPM_SWAP_POOL_ADDRESS: `0x${'77'.repeat(20)}`,
      MULTISEND_CALL_ONLY_ADDRESS: `0x${'88'.repeat(20)}`,
      MULTISEND_UNWRAPPER_ADDRESS: `0x${'99'.repeat(20)}`,
      DELEVERAGER_ENABLED: 'true',
    })
    const gated = TUNE_KNOBS.filter((k) => k.applies !== undefined)
    expect(gated.length).toBeGreaterThan(0)
    for (const knob of gated) {
      expect(knob.applies?.(off), knob.key).toBe(false)
      expect(knob.applies?.(on), knob.key).toBe(true)
    }
  })
})

describe('diffTuneAnswers', () => {
  it('keeps only answers that differ from the existing line or the schema default', () => {
    const env = { DELTA_THRESHOLD_BPS: '250' }
    const currents = { DELTA_THRESHOLD_BPS: '250', SLIPPAGE_BPS: '100', POLL_INTERVAL_MS: '60000' }
    const answers = {
      DELTA_THRESHOLD_BPS: '250', // unchanged explicit line → skip
      SLIPPAGE_BPS: '100', // unset key, answer equals default → skip
      POLL_INTERVAL_MS: '30000', // unset key, changed → keep
    }
    expect(diffTuneAnswers(env, answers, currents)).toEqual({ POLL_INTERVAL_MS: '30000' })
  })

  it('writes an explicit value when it differs from an existing line even if it equals the default', () => {
    const env = { DELTA_THRESHOLD_BPS: '250' }
    const answers = { DELTA_THRESHOLD_BPS: '200' }
    expect(diffTuneAnswers(env, answers, { DELTA_THRESHOLD_BPS: '250' })).toEqual({
      DELTA_THRESHOLD_BPS: '200',
    })
  })
})

describe('dotenvObject', () => {
  it('parses lines, skipping comments and blanks, preserving values with =', () => {
    expect(dotenvObject('# c\nA=1\n\nB=x=y\nnoequals\n')).toEqual({ A: '1', B: 'x=y' })
  })
})
