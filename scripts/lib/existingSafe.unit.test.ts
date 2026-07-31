import { describe, expect, it } from 'vitest'

import { modulePredecessor } from './existingSafe'

const A = (digit: string) => `0x${digit.repeat(40)}` as `0x${string}`
const SENTINEL = '0x0000000000000000000000000000000000000001'

describe('Safe module replacement', () => {
  it('resolves the linked-list predecessor needed to disable a module', () => {
    const first = A('1')
    const second = A('2')
    expect(modulePredecessor([first, second], SENTINEL, first)).toBe(SENTINEL)
    expect(modulePredecessor([first, second], SENTINEL, second)).toBe(first)
  })

  it('refuses an incomplete module page', () => {
    expect(() => modulePredecessor([A('1')], A('2'), A('1'))).toThrow(/more than 256/)
  })
})
