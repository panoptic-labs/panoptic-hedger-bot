import { describe, expect, it } from 'vitest'

import { parseHedgerBotConfig } from '../../src/config'
import { type EnvValues, renderEnvFile } from './renderEnv'

const BASE: EnvValues = {
  CHAIN_ID: 1,
  RPC_URL: 'https://rpc.example',
  POOL_ADDRESS: `0x${'1'.repeat(40)}`,
  SAFE_ADDRESS: `0x${'2'.repeat(40)}`,
  ROLES_MODIFIER_ADDRESS: `0x${'3'.repeat(40)}`,
  ROLE_KEY: `0x${'4'.repeat(64)}`,
  BOT_PRIVATE_KEY: `0x${'5'.repeat(64)}`,
  ASSET_INDEX: 1,
  DELTA_THRESHOLD_BPS: 200,
  PRICE_SIGNAL_SOURCE: 'pool-tick',
  HEDGE_VENUE: 'in-pool',
  DRY_RUN: true,
}

function toEnv(body: string): NodeJS.ProcessEnv {
  const out: NodeJS.ProcessEnv = {}
  for (const line of body.split('\n')) {
    const t = line.trim()
    if (!t || t.startsWith('#')) continue
    const eq = t.indexOf('=')
    out[t.slice(0, eq)] = t.slice(eq + 1)
  }
  return out
}

describe('renderEnvFile', () => {
  it('produces a body that parseHedgerBotConfig accepts', () => {
    const body = renderEnvFile(BASE)
    expect(() => parseHedgerBotConfig(toEnv(body))).not.toThrow()
    const cfg = parseHedgerBotConfig(toEnv(body))
    expect(cfg.CHAIN_ID).toBe(1)
    expect(cfg.ASSET_INDEX).toBe(1n)
    expect(cfg.DRY_RUN).toBe(true)
    expect(cfg.HEDGE_VENUE).toBe('in-pool')
  })

  it('omits undefined optional fields', () => {
    const body = renderEnvFile(BASE)
    expect(body).not.toContain('TELEGRAM_BOT_TOKEN')
    expect(body).not.toContain('MAX_HEDGE_SLOTS')
  })

  it('includes Telegram keys when provided', () => {
    const body = renderEnvFile({ ...BASE, TELEGRAM_BOT_TOKEN: 'tok', TELEGRAM_CHAT_ID: '-100' })
    expect(body).toContain('TELEGRAM_BOT_TOKEN=tok')
    expect(body).toContain('TELEGRAM_CHAT_ID=-100')
  })

  it('is deterministic', () => {
    expect(renderEnvFile(BASE)).toBe(renderEnvFile(BASE))
  })
})
