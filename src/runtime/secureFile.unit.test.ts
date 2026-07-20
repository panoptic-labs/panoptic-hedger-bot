import { chmodSync, mkdtempSync, readFileSync, statSync, symlinkSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import path from 'node:path'

import { describe, expect, it } from 'vitest'
import { z } from 'zod'

import { readSecureJson, writeSecureJson } from './secureFile'

const schema = z.object({ version: z.literal(1), value: z.string().max(32) }).strict()

describe('secure file policy', () => {
  it('atomically replaces a pre-existing 0644 file with mode 0600', () => {
    const directory = mkdtempSync(path.join(tmpdir(), 'secure-file-'))
    const target = path.join(directory, 'state.json')
    writeFileSync(target, '{}', { mode: 0o644 })
    chmodSync(target, 0o644)

    writeSecureJson(target, schema, { version: 1, value: 'safe' })

    expect(statSync(target).mode & 0o777).toBe(0o600)
    expect(readSecureJson(target, schema, { maxBytes: 1_024, invalid: 'throw' })).toEqual({
      version: 1,
      value: 'safe',
    })
  })

  it('rejects symlink targets without modifying their destination', () => {
    const directory = mkdtempSync(path.join(tmpdir(), 'secure-file-'))
    const destination = path.join(directory, 'destination.json')
    const target = path.join(directory, 'state.json')
    writeFileSync(destination, 'unchanged', { mode: 0o600 })
    symlinkSync(destination, target)

    expect(() => writeSecureJson(target, schema, { version: 1, value: 'unsafe' })).toThrow(
      /regular file/,
    )
    expect(readFileSync(destination, 'utf8')).toBe('unchanged')
  })

  it('rejects oversized, permissive, malformed, and wrong-shape reads', () => {
    const directory = mkdtempSync(path.join(tmpdir(), 'secure-file-'))
    const target = path.join(directory, 'state.json')
    writeFileSync(target, JSON.stringify({ version: 1, value: 'x'.repeat(64) }), { mode: 0o600 })
    expect(() => readSecureJson(target, schema, { maxBytes: 16, invalid: 'throw' })).toThrow(/size/)
    writeFileSync(target, '{bad', { mode: 0o600 })
    expect(() => readSecureJson(target, schema, { maxBytes: 1_024, invalid: 'throw' })).toThrow()
    writeFileSync(target, JSON.stringify({ version: 2, extra: true }), { mode: 0o600 })
    expect(() => readSecureJson(target, schema, { maxBytes: 1_024, invalid: 'throw' })).toThrow()
    chmodSync(target, 0o644)
    expect(() => readSecureJson(target, schema, { maxBytes: 1_024, invalid: 'throw' })).toThrow(
      /owner-only/,
    )
  })
})
