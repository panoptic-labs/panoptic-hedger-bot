import { describe, expect, it } from 'vitest'

import { deployStateSchema } from './setup'

// A minimal, valid version-1 deploy-state.json WITHOUT hedgeIncludeLp — as an
// interrupted deployment from a build predating LP hedging would have written.
const LEGACY_V1_STATE = {
  version: 1,
  safeMode: 'new',
  chainId: 1,
  rpcUrl: 'https://rpc.example',
  poolAddress: '0x1111111111111111111111111111111111111111',
  finalSafeOwner: '0x2222222222222222222222222222222222222222',
  botAddress: '0x3333333333333333333333333333333333333333',
  roleKey: '0x' + '11'.repeat(32),
  saltNonce: '0',
  assetIndex: 1,
  dryRun: false,
  storage: 'plaintext',
  extraRoles: [],
} as const

describe('deployStateSchema resume compatibility', () => {
  it('accepts a version-1 state without hedgeIncludeLp and defaults it to false', () => {
    const state = deployStateSchema.parse(LEGACY_V1_STATE)
    expect(state.hedgeIncludeLp).toBe(false)
    expect(state.sfpmSwapProvisioned).toBe(false)
  })

  it('preserves an explicit hedgeIncludeLp when present', () => {
    expect(
      deployStateSchema.parse({ ...LEGACY_V1_STATE, hedgeIncludeLp: true }).hedgeIncludeLp,
    ).toBe(true)
    expect(
      deployStateSchema.parse({ ...LEGACY_V1_STATE, hedgeIncludeLp: false }).hedgeIncludeLp,
    ).toBe(false)
  })

  it('preserves timed hedge settings in resumable state', () => {
    const state = deployStateSchema.parse({
      ...LEGACY_V1_STATE,
      timedHedgeIntervalMs: 14_400_000,
      timedHedgeMinDriftBps: 100,
    })
    expect(state.timedHedgeIntervalMs).toBe(14_400_000)
    expect(state.timedHedgeMinDriftBps).toBe(100)
  })

  it('rejects invalid enabled timed hedge settings before resume', () => {
    expect(() =>
      deployStateSchema.parse({
        ...LEGACY_V1_STATE,
        timedHedgeIntervalMs: 299_999,
        timedHedgeMinDriftBps: 100,
      }),
    ).toThrow(/300000/)
    expect(() =>
      deployStateSchema.parse({ ...LEGACY_V1_STATE, timedHedgeIntervalMs: 300_000 }),
    ).toThrow()
    expect(() =>
      deployStateSchema.parse({
        ...LEGACY_V1_STATE,
        deltaThresholdBps: 100,
        timedHedgeIntervalMs: 300_000,
        timedHedgeMinDriftBps: 100,
      }),
    ).toThrow(/below the delta threshold/)
  })
})
