import { describe, expect, it } from 'vitest'

import { assessSafety } from './safety'

describe('assessSafety', () => {
  it('verdict=hedge when healthy', () => {
    const r = assessSafety({ poolHealthStatus: 'active', isLiquidatable: false })
    expect(r.verdict).toBe('hedge')
    expect(r.safe).toBe(true)
    expect(r.paused).toBe(false)
  })

  it('verdict=skip when liquidatable and no deleverager', () => {
    const r = assessSafety({ poolHealthStatus: 'active', isLiquidatable: true })
    expect(r.verdict).toBe('skip')
    expect(r.reasons).toContain('account is liquidatable')
  })

  it('verdict=deleverage when liquidatable and deleverager enabled', () => {
    const r = assessSafety({
      poolHealthStatus: 'active',
      isLiquidatable: true,
      deleverage: { enabled: true, bufferBps: 9_000n, triggerMarginBps: 500n },
    })
    expect(r.verdict).toBe('deleverage')
  })

  it('verdict=deleverage on a low-buffer trigger even when not liquidatable', () => {
    const r = assessSafety({
      poolHealthStatus: 'active',
      isLiquidatable: false,
      deleverage: { enabled: true, bufferBps: 300n, triggerMarginBps: 500n },
    })
    expect(r.verdict).toBe('deleverage')
    expect(r.reasons.join(' ')).toMatch(/margin buffer 300bps below 500bps/)
  })

  it('verdict=skip when at risk but deleverager present-yet-disabled', () => {
    const r = assessSafety({
      poolHealthStatus: 'active',
      isLiquidatable: false,
      deleverage: { enabled: false, bufferBps: 300n, triggerMarginBps: 500n },
    })
    expect(r.verdict).toBe('skip')
  })

  it('DELEVERAGES while paused (close-only) when at risk and enabled', () => {
    const r = assessSafety({
      poolHealthStatus: 'paused',
      isLiquidatable: true,
      deleverage: { enabled: true, bufferBps: 0n, triggerMarginBps: 500n },
    })
    expect(r.verdict).toBe('deleverage')
    expect(r.paused).toBe(true)
    expect(r.reasons).toContain('pool is paused (close-only)')
  })

  it('a paused pool skips the normal hedge path when healthy', () => {
    const r = assessSafety({ poolHealthStatus: 'paused', isLiquidatable: false })
    expect(r.verdict).toBe('skip')
    expect(r.paused).toBe(true)
  })

  it('a paused pool at risk with no deleverager still skips', () => {
    const r = assessSafety({
      poolHealthStatus: 'paused',
      isLiquidatable: false,
      deleverage: { enabled: false, bufferBps: 100n, triggerMarginBps: 500n },
    })
    expect(r.verdict).toBe('skip')
  })
})
