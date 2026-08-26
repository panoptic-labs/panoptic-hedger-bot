import { describe, expect, it } from 'vitest'

import { formatAsciiBox, formatLogColumns } from './log'

describe('operator log formatting', () => {
  it('separates dense fields into tabbed columns', () => {
    expect(
      formatLogColumns('[hedger-bot] reconcile', [
        'action=none',
        'netDelta=-7.989537 USDC',
        'drift=53bps',
      ]),
    ).toBe('[hedger-bot] reconcile\t| action=none\t| netDelta=-7.989537 USDC\t| drift=53bps')
  })

  it('frames and pads every warning line to the same width', () => {
    const box = formatAsciiBox('[hedger-bot]', ['DRY RUN', '', 'Nothing will be sent.'])

    expect(box).toEqual([
      '[hedger-bot] +-----------------------+',
      '[hedger-bot] | DRY RUN               |',
      '[hedger-bot] |                       |',
      '[hedger-bot] | Nothing will be sent. |',
      '[hedger-bot] +-----------------------+',
    ])
  })
})
