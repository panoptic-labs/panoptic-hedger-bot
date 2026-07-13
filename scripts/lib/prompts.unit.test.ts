import { PassThrough } from 'node:stream'

import { describe, expect, it } from 'vitest'

import { Prompter } from './prompts'

// Drive the Prompter with scripted stdin lines and a throwaway output sink.
function harness(lines: string[]): Prompter {
  const input = new PassThrough()
  const output = new PassThrough()
  const p = new Prompter({ input, output })
  // Feed answers one per tick AFTER the caller registers each question:
  // readline ignores data buffered before it listens, and drops a 'line' that
  // fires between two prompts, so pace one line per macrotask.
  let i = 0
  const feed = (): void => {
    if (i < lines.length) {
      input.write(`${lines[i++]}\n`)
      setImmediate(feed)
    }
  }
  setImmediate(feed)
  return p
}

const OPTS = [
  { label: 'zero', value: '0' as const },
  { label: 'one', value: '1' as const },
]

describe('Prompter.choice (numeric [0]/[1])', () => {
  it('maps the typed index to the option value', async () => {
    const p = harness(['1'])
    expect(await p.choice('pick', OPTS)).toBe('1')
    p.close()
  })

  it('index and value coincide for the ASSET_INDEX-style menu', async () => {
    const p = harness(['0'])
    expect(await p.choice('ASSET_INDEX', OPTS, '1')).toBe('0')
    p.close()
  })

  it('uses the default value when the line is empty', async () => {
    const p = harness([''])
    expect(await p.choice('pick', OPTS, '1')).toBe('1')
    p.close()
  })

  it('re-prompts on an out-of-range entry, then accepts a valid one', async () => {
    const p = harness(['5', '0'])
    expect(await p.choice('pick', OPTS)).toBe('0')
    p.close()
  })

  it('handles multi-digit indices (>9 options)', async () => {
    const many = Array.from({ length: 12 }, (_, i) => ({
      label: `opt${i}`,
      value: String(i) as `${number}`,
    }))
    const p = harness(['11'])
    expect(await p.choice('pick', many)).toBe('11')
    p.close()
  })
})
