import { describe, expect, it } from 'vitest'

import {
  expectedAttempts,
  makeSafeAddressPredictor,
  mineVanitySafeSalt,
  normalizeVanityPrefix,
  validateVanityPrefix,
} from './vanitySafe'

// Arbitrary but fixed inputs — the predictor is a pure CREATE2 computation, so
// these don't need to be real Safe deployments to exercise the loop + matching.
// (Correctness against the real factory is asserted in setup.fork.test.ts.)
const PARAMS = {
  factory: '0x4e1DCf7AD4e460CfD30791CCC4F9c8a4f820ec67' as const,
  singleton: '0x29fcB43b46531BcA003ddC8FCB67FFE91900C762' as const,
  initializer: `0x${'ab'.repeat(64)}` as const,
  proxyCreationCode: `0x${'60806040'.repeat(4)}` as const,
}

describe('normalizeVanityPrefix', () => {
  it('strips 0x and lowercases', () => {
    expect(normalizeVanityPrefix('0xBEEF')).toBe('beef')
    expect(normalizeVanityPrefix('  DeAd ')).toBe('dead')
  })
})

describe('validateVanityPrefix', () => {
  it('accepts hex up to the max length', () => {
    expect(validateVanityPrefix('beef')).toBeUndefined()
    expect(validateVanityPrefix('0xABCDEF')).toBeUndefined()
  })
  it('rejects empty, non-hex, and over-long input', () => {
    expect(validateVanityPrefix('')).toBeDefined()
    expect(validateVanityPrefix('xyz')).toBeDefined()
    expect(validateVanityPrefix('0x123456789', 8)).toBeDefined()
  })
})

describe('expectedAttempts', () => {
  it('is 16^n', () => {
    expect(expectedAttempts(1)).toBe(16)
    expect(expectedAttempts(4)).toBe(65536)
  })
})

describe('makeSafeAddressPredictor', () => {
  it('is deterministic and produces a 20-byte address', () => {
    const predict = makeSafeAddressPredictor(PARAMS)
    const a = predict(1n)
    expect(a).toMatch(/^0x[0-9a-fA-F]{40}$/)
    expect(predict(1n)).toBe(a)
    expect(predict(2n)).not.toBe(a)
  })
})

describe('mineVanitySafeSalt', () => {
  it('finds a salt whose predicted address carries the prefix', async () => {
    const prefix = 'a'
    const { saltNonce, address, attempts } = await mineVanitySafeSalt({
      ...PARAMS,
      prefix,
      start: 0n,
    })
    expect(address.slice(2, 2 + prefix.length).toLowerCase()).toBe(prefix)
    expect(attempts).toBeGreaterThan(0)
    // The returned salt reproduces the winning address.
    expect(makeSafeAddressPredictor(PARAMS)(saltNonce)).toBe(address)
  })

  it('throws when no match is found within maxAttempts', async () => {
    await expect(
      mineVanitySafeSalt({ ...PARAMS, prefix: 'abcdef', start: 0n, maxAttempts: 5 }),
    ).rejects.toThrow(/no vanity match/)
  })
})
