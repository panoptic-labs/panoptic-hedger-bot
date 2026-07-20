import { afterEach, describe, expect, it, vi } from 'vitest'

import { renderDoctor } from './render'

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
