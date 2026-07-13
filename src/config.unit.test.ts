import { describe, expect, it } from 'vitest'

import { parseHedgerBotConfig } from './config'

const BASE_ENV = {
  CHAIN_ID: '1',
  RPC_URL: 'https://rpc.example',
  POOL_ADDRESS: '0x1111111111111111111111111111111111111111',
  SAFE_ADDRESS: '0x2222222222222222222222222222222222222222',
  ROLES_MODIFIER_ADDRESS: '0x3333333333333333333333333333333333333333',
  ROLE_KEY: '0x' + '11'.repeat(32),
  BOT_PRIVATE_KEY: '0x' + '22'.repeat(32),
  ASSET_INDEX: '1',
} satisfies NodeJS.ProcessEnv

describe('parseHedgerBotConfig', () => {
  it('parses a minimal valid env with defaults', () => {
    const cfg = parseHedgerBotConfig({ ...BASE_ENV })
    expect(cfg.CHAIN_ID).toBe(1)
    expect(cfg.ASSET_INDEX).toBe(1n)
    expect(cfg.DELTA_THRESHOLD_BPS).toBe(200n)
    expect(cfg.MAX_HEDGE_SLOTS).toBe(4)
    expect(cfg.SLIPPAGE_BPS).toBe(30)
    expect(cfg.PRICE_SIGNAL_SOURCE).toBe('pool-tick')
    expect(cfg.POLL_INTERVAL_MS).toBe(60_000)
    expect(cfg.DRY_RUN).toBe(false)
  })

  it('coerces DRY_RUN and numeric fields', () => {
    const cfg = parseHedgerBotConfig({
      ...BASE_ENV,
      DRY_RUN: 'true',
      DELTA_THRESHOLD_BPS: '150',
      POLL_INTERVAL_MS: '30000',
    })
    expect(cfg.DRY_RUN).toBe(true)
    expect(cfg.DELTA_THRESHOLD_BPS).toBe(150n)
    expect(cfg.POLL_INTERVAL_MS).toBe(30_000)
  })

  it('rejects an invalid address', () => {
    expect(() => parseHedgerBotConfig({ ...BASE_ENV, POOL_ADDRESS: '0xnope' })).toThrow(
      /POOL_ADDRESS/,
    )
  })

  it('requires UNISWAP_SIGNAL_POOL_ADDRESS when source is uniswap-pool', () => {
    expect(() =>
      parseHedgerBotConfig({ ...BASE_ENV, PRICE_SIGNAL_SOURCE: 'uniswap-pool' }),
    ).toThrow(/UNISWAP_SIGNAL_POOL_ADDRESS/)
  })

  it('accepts uniswap-pool source when the signal pool is provided', () => {
    const cfg = parseHedgerBotConfig({
      ...BASE_ENV,
      PRICE_SIGNAL_SOURCE: 'uniswap-pool',
      UNISWAP_SIGNAL_POOL_ADDRESS: '0x4444444444444444444444444444444444444444',
    })
    expect(cfg.PRICE_SIGNAL_SOURCE).toBe('uniswap-pool')
  })

  it('defaults CEX_SYMBOL to ETH-USD when source is cex', () => {
    const cfg = parseHedgerBotConfig({ ...BASE_ENV, PRICE_SIGNAL_SOURCE: 'cex' })
    expect(cfg.PRICE_SIGNAL_SOURCE).toBe('cex')
    expect(cfg.CEX_SYMBOL).toBe('ETH-USD')
  })

  it('requires TELEGRAM_CHAT_ID when a Telegram token is set', () => {
    expect(() => parseHedgerBotConfig({ ...BASE_ENV, TELEGRAM_BOT_TOKEN: '123:abc' })).toThrow(
      /TELEGRAM_CHAT_ID/,
    )
  })

  it('accepts both Telegram vars together', () => {
    const cfg = parseHedgerBotConfig({
      ...BASE_ENV,
      TELEGRAM_BOT_TOKEN: '123:abc',
      TELEGRAM_CHAT_ID: '-100123',
    })
    expect(cfg.TELEGRAM_BOT_TOKEN).toBe('123:abc')
    expect(cfg.TELEGRAM_CHAT_ID).toBe('-100123')
  })
})
