import { chmodSync, mkdtempSync, readdirSync, symlinkSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import path from 'node:path'

import type { Address, Hex } from 'viem'
import { afterEach, beforeEach, describe, expect, it } from 'vitest'

import { parseHedgerBotConfig } from '../config'
import {
  type ActivationEvidence,
  buildActivationMarker,
  clearActivation,
  isActivated,
  readActivation,
  writeActivation,
} from './activation'

const SAFE: Address = '0x00000000000000000000000000000000000000aa'
const POOL: Address = '0x00000000000000000000000000000000000000bb'
const MODIFIER: Address = '0x00000000000000000000000000000000000000cc'
const BOT: Address = '0x00000000000000000000000000000000000000dd'
const ROLE_KEY = `0x${'11'.repeat(32)}` as Hex
const HASH_A = `0x${'aa'.repeat(32)}` as Hex
const HASH_B = `0x${'bb'.repeat(32)}` as Hex

const config = parseHedgerBotConfig({
  CHAIN_ID: '1',
  RPC_URL: 'https://synthetic.invalid/rpc',
  POOL_ADDRESS: POOL,
  SAFE_ADDRESS: SAFE,
  ROLES_MODIFIER_ADDRESS: MODIFIER,
  ROLE_KEY,
  BOT_PRIVATE_KEY: `0x${'22'.repeat(32)}`,
  ASSET_INDEX: '0',
  DRY_RUN: 'false',
})
const evidence: ActivationEvidence = {
  codeIdentityFingerprint: HASH_A,
  permissionManifestFingerprint: HASH_B,
}

describe('activation marker', () => {
  let dir: string
  let markerPath: string

  beforeEach(() => {
    dir = mkdtempSync(path.join(tmpdir(), 'hedger-act-'))
    markerPath = path.join(dir, '.hedger-activated.json')
    process.env.HEDGER_ACTIVATED_PATH = markerPath
  })

  afterEach(() => {
    clearActivation()
    delete process.env.HEDGER_ACTIVATED_PATH
  })

  function marker(at = '2026-01-01T00:00:00.000Z') {
    return buildActivationMarker(config, BOT, evidence, true, at)
  }

  it('is activated only for an exact complete policy fingerprint', () => {
    writeActivation(marker())
    expect(isActivated(config, BOT, evidence)).toBe(true)

    const mutations = [
      { ...config, RPC_URL: 'https://different.invalid/rpc' },
      { ...config, SAFE_ADDRESS: POOL },
      { ...config, POOL_ADDRESS: SAFE },
      { ...config, ROLES_MODIFIER_ADDRESS: SAFE },
      { ...config, ROLE_KEY: `0x${'33'.repeat(32)}` as Hex },
      { ...config, ASSET_INDEX: 1n },
      { ...config, DELTA_THRESHOLD_BPS: config.DELTA_THRESHOLD_BPS + 1n },
      { ...config, MAX_HEDGE_SLOTS: config.MAX_HEDGE_SLOTS + 1 },
      { ...config, SLIPPAGE_BPS: config.SLIPPAGE_BPS + 1 },
      { ...config, MIN_MARGIN_RESERVE_BPS: config.MIN_MARGIN_RESERVE_BPS + 1n },
      { ...config, PANOPTIC_BUILDER_CODE: 'synthetic-builder' },
      { ...config, PRICE_SIGNAL_SOURCE: 'cex' as const },
      { ...config, SIGNAL_TICK_SANITY_MAX: config.SIGNAL_TICK_SANITY_MAX + 1 },
      { ...config, MAX_SIGNAL_BLOCK_AGE_SECONDS: config.MAX_SIGNAL_BLOCK_AGE_SECONDS + 1 },
      { ...config, CEX_SYMBOL: 'ETH-USDT' },
      { ...config, CEX_STALE_MS: config.CEX_STALE_MS + 1 },
      { ...config, CEX_MIN_FEEDS: config.CEX_MIN_FEEDS - 1 },
      { ...config, UNISWAP_SIGNAL_POOL_VERSION: 'v4' as const },
      { ...config, UNISWAP_SIGNAL_POOL_ADDRESS: BOT },
      { ...config, UNISWAP_SIGNAL_STATE_VIEW_ADDRESS: BOT },
      { ...config, UNISWAP_SIGNAL_POOL_ID: HASH_A },
      { ...config, POLL_INTERVAL_MS: config.POLL_INTERVAL_MS + 1 },
      { ...config, MAX_FEE_GWEI: config.MAX_FEE_GWEI + 1n },
      { ...config, MAX_PRIORITY_FEE_GWEI: config.MAX_PRIORITY_FEE_GWEI + 1n },
      { ...config, URGENT_PRIORITY_FEE_GWEI: config.URGENT_PRIORITY_FEE_GWEI + 1n },
      { ...config, HEDGE_MAX_BASE_FEE_GWEI: config.HEDGE_MAX_BASE_FEE_GWEI + 1n },
      { ...config, URGENT_MAX_BASE_FEE_GWEI: config.URGENT_MAX_BASE_FEE_GWEI + 1n },
      { ...config, URGENT_DRIFT_MULTIPLIER: config.URGENT_DRIFT_MULTIPLIER + 1 },
      { ...config, MIN_KEEPER_BALANCE_ETH: config.MIN_KEEPER_BALANCE_ETH + 1n },
      { ...config, KEEPER_BALANCE_WARN_ETH: config.KEEPER_BALANCE_WARN_ETH + 1n },
      { ...config, TX_RECEIPT_TIMEOUT_MS: config.TX_RECEIPT_TIMEOUT_MS + 1 },
      { ...config, TX_BUMP_INTERVAL_MS: config.TX_BUMP_INTERVAL_MS + 1 },
      { ...config, DELEVERAGER_ENABLED: true },
    ]
    for (const changed of mutations) expect(isActivated(changed, BOT, evidence)).toBe(false)
    expect(isActivated(config, SAFE, evidence)).toBe(false)
    expect(isActivated(config, BOT, { ...evidence, codeIdentityFingerprint: HASH_B })).toBe(false)
    expect(isActivated(config, BOT, { ...evidence, permissionManifestFingerprint: HASH_A })).toBe(
      false,
    )
  })

  it('canonicalizes address case', () => {
    writeActivation(marker())
    expect(
      isActivated(
        { ...config, SAFE_ADDRESS: `0x${SAFE.slice(2).toUpperCase()}` },
        `0x${BOT.slice(2).toUpperCase()}`,
        evidence,
      ),
    ).toBe(true)
  })

  it('fails closed for missing, malformed, truncated, oversized, old, and wrong-shape files', () => {
    expect(isActivated(config, BOT, evidence)).toBe(false)
    const invalid = [
      '{',
      '{}',
      JSON.stringify({ ...marker(), schemaVersion: 1 }),
      JSON.stringify({ ...marker(), doctorPassed: false }),
      JSON.stringify({ ...marker(), unexpected: true }),
      'x'.repeat(16 * 1024 + 1),
    ]
    for (const fixture of invalid) {
      writeFileSync(markerPath, fixture, { mode: 0o600 })
      expect(readActivation()).toBeNull()
      expect(isActivated(config, BOT, evidence)).toBe(false)
    }
  })

  it('rejects permissive modes and symlink targets', () => {
    writeFileSync(markerPath, JSON.stringify(marker()), { mode: 0o644 })
    chmodSync(markerPath, 0o644)
    expect(readActivation()).toBeNull()
    expect(() => writeActivation(marker())).not.toThrow()
    expect(readActivation()).toEqual(marker())

    clearActivation()
    const target = path.join(dir, 'elsewhere')
    writeFileSync(target, JSON.stringify(marker()), { mode: 0o600 })
    symlinkSync(target, markerPath)
    expect(readActivation()).toBeNull()
    expect(() => writeActivation(marker())).toThrow(/regular file/)
  })

  it('atomically replaces a valid marker without leaving temporary files', () => {
    writeActivation(marker())
    writeActivation(marker('2026-01-02T00:00:00.000Z'))
    expect(readActivation()?.activatedAt).toBe('2026-01-02T00:00:00.000Z')
    expect(readdirSync(dir).filter((name) => name.includes('.tmp-'))).toEqual([])
  })
})
