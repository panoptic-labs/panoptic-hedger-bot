import { describe, expect, it } from 'vitest'

import { timedHedgeCadence } from './timedCadence'

describe('timedHedgeCadence', () => {
  const now = Date.parse('2026-01-01T04:00:00Z')

  it('is disabled at interval zero', () => {
    expect(timedHedgeCadence(0, undefined, now)).toEqual({
      enabled: false,
      due: false,
      lastDeltaHedgeAt: null,
      nextDueAt: null,
    })
  })

  it('is immediately due without trusted history', () => {
    expect(timedHedgeCadence(3_600_000, undefined, now).due).toBe(true)
    expect(timedHedgeCadence(3_600_000, 'not-a-date', now).due).toBe(true)
  })

  it('becomes due at the interval and remains due afterward', () => {
    const last = '2026-01-01T02:00:00Z'
    expect(timedHedgeCadence(3_600_000, last, now - 3_600_001).due).toBe(false)
    expect(timedHedgeCadence(3_600_000, last, now).due).toBe(true)
    expect(timedHedgeCadence(3_600_000, last, now + 60_000).due).toBe(true)
  })
})
