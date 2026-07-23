import { DELEVERAGER_ROLE_KEY as SDK_DELEVERAGER_ROLE_KEY } from '@panoptic-eng/sdk/zodiac'
import { parseGwei } from 'viem'
import { describe, expect, it } from 'vitest'

import { deleveragerRoleKey, parseHedgerBotConfig } from './config'

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
    expect(cfg.SLIPPAGE_BPS).toBe(100)
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

  it('defaults the deleverager off with sane tunables', () => {
    const cfg = parseHedgerBotConfig({ ...BASE_ENV })
    expect(cfg.DELEVERAGER_ENABLED).toBe(false)
    expect(cfg.DELEVERAGE_TRIGGER_MARGIN_BPS).toBe(500n)
    expect(cfg.DELEVERAGE_TARGET_MARGIN_BPS).toBe(1_500n)
    expect(cfg.DELEVERAGE_SLIPPAGE_BPS).toBe(300)
    expect(cfg.DELEVERAGE_COOLDOWN_MS).toBe(300_000)
  })

  it('deleveragerRoleKey falls back to the SDK canonical key when unset', () => {
    expect(deleveragerRoleKey({ DELEVERAGER_ROLE_KEY: undefined })).toBe(SDK_DELEVERAGER_ROLE_KEY)
  })

  it('deleveragerRoleKey returns a configured override unchanged', () => {
    const override = ('0x' + 'cd'.repeat(32)) as `0x${string}`
    expect(deleveragerRoleKey({ DELEVERAGER_ROLE_KEY: override })).toBe(override)
  })

  it('accepts an enabled deleverager with valid tunables', () => {
    const cfg = parseHedgerBotConfig({ ...BASE_ENV, DELEVERAGER_ENABLED: 'true' })
    expect(cfg.DELEVERAGER_ENABLED).toBe(true)
  })

  it('rejects a deleverager role key that equals ROLE_KEY', () => {
    expect(() =>
      parseHedgerBotConfig({
        ...BASE_ENV,
        DELEVERAGER_ENABLED: 'true',
        DELEVERAGER_ROLE_KEY: BASE_ENV.ROLE_KEY,
      }),
    ).toThrow(/must differ from ROLE_KEY/)
  })

  it('rejects a deleverager role key set while disabled', () => {
    expect(() =>
      parseHedgerBotConfig({
        ...BASE_ENV,
        DELEVERAGER_ROLE_KEY: '0x' + 'ab'.repeat(32),
      }),
    ).toThrow(/DELEVERAGER_ENABLED is false/)
  })

  it('rejects a trigger at or above the target when enabled', () => {
    expect(() =>
      parseHedgerBotConfig({
        ...BASE_ENV,
        DELEVERAGER_ENABLED: 'true',
        DELEVERAGE_TRIGGER_MARGIN_BPS: '1500',
        DELEVERAGE_TARGET_MARGIN_BPS: '1500',
      }),
    ).toThrow(/below DELEVERAGE_TARGET_MARGIN_BPS/)
  })

  it('rejects a trigger at or above MIN_MARGIN_RESERVE_BPS when enabled', () => {
    expect(() =>
      parseHedgerBotConfig({
        ...BASE_ENV,
        DELEVERAGER_ENABLED: 'true',
        DELEVERAGE_TRIGGER_MARGIN_BPS: '2000',
        MIN_MARGIN_RESERVE_BPS: '2000',
        DELEVERAGE_TARGET_MARGIN_BPS: '3000',
      }),
    ).toThrow(/below MIN_MARGIN_RESERVE_BPS/)
  })

  it('accepts UNISWAP_LP_OWNER equal to SAFE_ADDRESS (dedup makes it harmless)', () => {
    // The Safe is always scanned; a UNISWAP_LP_OWNER pointed at it is deduped in
    // readSafeLpPositions, so it is redundant rather than a double-count error.
    const cfg = parseHedgerBotConfig({ ...BASE_ENV, UNISWAP_LP_OWNER: BASE_ENV.SAFE_ADDRESS })
    expect(cfg.UNISWAP_LP_OWNER).toBe(BASE_ENV.SAFE_ADDRESS)
  })

  it('accepts a distinct UNISWAP_LP_OWNER with LP hedging enabled', () => {
    const cfg = parseHedgerBotConfig({
      ...BASE_ENV,
      UNISWAP_LP_OWNER: '0x4444444444444444444444444444444444444444',
      HEDGE_INCLUDE_LP: 'true',
    })
    expect(cfg.UNISWAP_LP_OWNER).toBe('0x4444444444444444444444444444444444444444')
    expect(cfg.HEDGE_INCLUDE_LP).toBe(true)
    expect(cfg.LP_SUBGRAPH_MAX_LAG_BLOCKS).toBe(50n)
  })

  it('allows HEDGE_INCLUDE_LP with no UNISWAP_LP_OWNER (Safe-only LP is valid)', () => {
    const cfg = parseHedgerBotConfig({ ...BASE_ENV, HEDGE_INCLUDE_LP: 'true' })
    expect(cfg.HEDGE_INCLUDE_LP).toBe(true)
    expect(cfg.UNISWAP_LP_OWNER).toBeUndefined()
  })

  it('does not enforce deleverage tuning relationships while disabled', () => {
    // trigger >= target would be rejected only when enabled.
    const cfg = parseHedgerBotConfig({
      ...BASE_ENV,
      DELEVERAGE_TRIGGER_MARGIN_BPS: '4000',
      DELEVERAGE_TARGET_MARGIN_BPS: '1500',
    })
    expect(cfg.DELEVERAGER_ENABLED).toBe(false)
  })

  it('rejects removed cross-pool execution settings', () => {
    expect(() =>
      parseHedgerBotConfig({
        ...BASE_ENV,
        HEDGE_VENUE: 'cross-pool-uniswap',
        HEDGE_POOLS: '[]',
      }),
    ).toThrow(/HEDGE_VENUE, HEDGE_POOLS: cross-pool execution was removed/)
    expect(() => parseHedgerBotConfig({ ...BASE_ENV, HEDGE_POOLS: '[]' })).toThrow(
      /cross-pool execution was removed/,
    )
    expect(() => parseHedgerBotConfig({ ...BASE_ENV, HEDGE_VENUE: 'unsupported' })).toThrow(
      /HEDGE_VENUE/,
    )
  })

  it('rejects an invalid address', () => {
    expect(() => parseHedgerBotConfig({ ...BASE_ENV, POOL_ADDRESS: '0xnope' })).toThrow(
      /POOL_ADDRESS/,
    )
  })

  it('accepts lowercase addresses and rejects invalid mixed-case checksums', () => {
    expect(() => parseHedgerBotConfig({ ...BASE_ENV })).not.toThrow()
    expect(() =>
      parseHedgerBotConfig({
        ...BASE_ENV,
        POOL_ADDRESS: '0x5AAeb6053F3E94C9b9A09f33669435E7Ef1BeAed',
      }),
    ).toThrow(/POOL_ADDRESS/)
  })

  it('requires encrypted remote RPC transport and forbids embedded credentials', () => {
    expect(() => parseHedgerBotConfig({ ...BASE_ENV, RPC_URL: 'http://rpc.example' })).toThrow(
      /RPC_URL/,
    )
    expect(() =>
      parseHedgerBotConfig({
        ...BASE_ENV,
        RPC_URL: ['https://user', 'pass@rpc.example'].join(':'),
      }),
    ).toThrow(/RPC_URL/)
    expect(() =>
      parseHedgerBotConfig({ ...BASE_ENV, RPC_URL: 'http://127.0.0.1:8545' }),
    ).not.toThrow()
  })

  it('allows at most one non-interactive keystore passphrase source', () => {
    expect(() =>
      parseHedgerBotConfig({
        ...BASE_ENV,
        BOT_PRIVATE_KEY: undefined,
        BOT_KEYSTORE_PATH: './synthetic.keystore.json',
        BOT_KEYSTORE_PASSPHRASE: 'synthetic',
        BOT_KEYSTORE_PASSPHRASE_FILE: './synthetic-passphrase',
      }),
    ).toThrow(/BOT_KEYSTORE_PASSPHRASE_FILE/)
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

  it('defaults the urgent tip floor and bump interval', () => {
    const cfg = parseHedgerBotConfig({ ...BASE_ENV })
    expect(cfg.URGENT_PRIORITY_FEE_GWEI).toBe(parseGwei('1'))
    expect(cfg.TX_BUMP_INTERVAL_MS).toBe(45_000)
  })

  it('allows the urgent tip floor to exceed the routine tip ceiling', () => {
    const cfg = parseHedgerBotConfig({
      ...BASE_ENV,
      MAX_PRIORITY_FEE_GWEI: '2',
      URGENT_PRIORITY_FEE_GWEI: '5',
    })
    expect(cfg.URGENT_PRIORITY_FEE_GWEI).toBe(parseGwei('5'))
  })

  it('rejects an urgent tip floor above MAX_FEE_GWEI', () => {
    expect(() =>
      parseHedgerBotConfig({ ...BASE_ENV, MAX_FEE_GWEI: '300', URGENT_PRIORITY_FEE_GWEI: '301' }),
    ).toThrow(/URGENT_PRIORITY_FEE_GWEI/)
  })

  it('rejects a bump interval longer than the receipt budget', () => {
    expect(() =>
      parseHedgerBotConfig({
        ...BASE_ENV,
        TX_RECEIPT_TIMEOUT_MS: '60000',
        TX_BUMP_INTERVAL_MS: '90000',
      }),
    ).toThrow(/TX_BUMP_INTERVAL_MS/)
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

  it.each([
    ['SLIPPAGE_BPS', '0', '500', '-1', '501'],
    ['POLL_INTERVAL_MS', '5000', '300000', '4999', '300001'],
    ['CEX_STALE_MS', '1000', '60000', '999', '60001'],
    ['SIGNAL_TICK_SANITY_MAX', '100', '10000', '99', '10001'],
    ['MAX_HEDGE_SLOTS', '1', '16', '0', '17'],
    ['DELTA_THRESHOLD_BPS', '1', '5000', '0', '5001'],
    ['URGENT_DRIFT_MULTIPLIER', '1', '20', '0', '21'],
    ['MIN_MARGIN_RESERVE_BPS', '500', '9000', '499', '9001'],
    ['MAX_SIGNAL_BLOCK_AGE_SECONDS', '15', '120', '14', '121'],
  ])('bounds %s at min/max and rejects adjacent values', (field, min, max, below, above) => {
    expect(() => parseHedgerBotConfig({ ...BASE_ENV, [field]: min })).not.toThrow()
    expect(() => parseHedgerBotConfig({ ...BASE_ENV, [field]: max })).not.toThrow()
    expect(() => parseHedgerBotConfig({ ...BASE_ENV, [field]: below })).toThrow(field)
    expect(() => parseHedgerBotConfig({ ...BASE_ENV, [field]: above })).toThrow(field)
  })

  it('bounds receipt timeout with a compatible bump interval', () => {
    expect(() =>
      parseHedgerBotConfig({
        ...BASE_ENV,
        TX_RECEIPT_TIMEOUT_MS: '30000',
        TX_BUMP_INTERVAL_MS: '5000',
      }),
    ).not.toThrow()
    expect(() =>
      parseHedgerBotConfig({ ...BASE_ENV, TX_RECEIPT_TIMEOUT_MS: '900000' }),
    ).not.toThrow()
    expect(() => parseHedgerBotConfig({ ...BASE_ENV, TX_RECEIPT_TIMEOUT_MS: '29999' })).toThrow(
      /TX_RECEIPT_TIMEOUT_MS/,
    )
    expect(() => parseHedgerBotConfig({ ...BASE_ENV, TX_RECEIPT_TIMEOUT_MS: '900001' })).toThrow(
      /TX_RECEIPT_TIMEOUT_MS/,
    )
  })

  it.each(['NaN', 'Infinity', '1e3', '1.5', '9007199254740993'])(
    'rejects unsafe integer syntax/value %s',
    (value) => {
      expect(() => parseHedgerBotConfig({ ...BASE_ENV, POLL_INTERVAL_MS: value })).toThrow(
        /POLL_INTERVAL_MS/,
      )
    },
  )

  it.each(['NaN', 'Infinity', '1e2', '-1'])('rejects unsafe decimal syntax/value %s', (value) => {
    expect(() => parseHedgerBotConfig({ ...BASE_ENV, MAX_FEE_GWEI: value })).toThrow(/MAX_FEE_GWEI/)
  })

  it('requires a three-feed quorum for CEX production mode', () => {
    expect(() =>
      parseHedgerBotConfig({ ...BASE_ENV, PRICE_SIGNAL_SOURCE: 'cex', CEX_MIN_FEEDS: '2' }),
    ).toThrow(/CEX_MIN_FEEDS/)
  })

  it('requires the keeper warning threshold below the target balance', () => {
    expect(() =>
      parseHedgerBotConfig({
        ...BASE_ENV,
        MIN_KEEPER_BALANCE_ETH: '0.05',
        KEEPER_BALANCE_WARN_ETH: '0.05',
      }),
    ).toThrow(/KEEPER_BALANCE_WARN_ETH/)
  })
})
