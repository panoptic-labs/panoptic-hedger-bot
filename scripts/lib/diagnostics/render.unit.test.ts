import { afterEach, describe, expect, it, vi } from 'vitest'

import { renderDoctor, renderStatus } from './render'
import type { StatusSnapshot } from './status'

describe('renderDoctor', () => {
  const log = vi.spyOn(console, 'log').mockImplementation(() => {})

  afterEach(() => {
    log.mockClear()
  })

  it('allows activation to continue when the permission manifest is advisory', () => {
    expect(
      renderDoctor([
        {
          id: 'permission-manifest',
          title: 'Complete Roles permission manifest',
          status: 'warn',
          detail: 'synthetic stale permission',
          remedy: 'Review the modifier.',
        },
      ]),
    ).toBe(true)
  })
})

describe('renderStatus — Uniswap LP row', () => {
  const log = vi.spyOn(console, 'log').mockImplementation(() => {})
  afterEach(() => log.mockClear())

  const base: StatusSnapshot = {
    version: '0.0.0',
    running: 'stopped',
    readiness: 'not activated',
    nextStartMode: 'dry-run',
    chainId: 1,
    pool: '0xpool',
    safe: '0xsafe',
    notes: [],
  }
  const output = () => log.mock.calls.map((c) => String(c[0])).join('\n')

  it('renders the LP row when lp is set', () => {
    renderStatus({ ...base, lp: '2 pos [Safe], head=100 lag=1 (fresh), Δ 0.5 ETH (applied)' })
    expect(output()).toContain('uniswap lp')
    expect(output()).toContain('2 pos [Safe]')
    expect(output()).toContain('(fresh)')
  })

  it('omits the LP row entirely when LP tracking is off (lp undefined)', () => {
    renderStatus(base)
    expect(output()).not.toContain('uniswap lp')
  })
})
