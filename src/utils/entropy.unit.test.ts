import { privateKeyToAccount } from 'viem/accounts'
import { describe, expect, it } from 'vitest'

import { deriveBotPrivateKey } from './entropy'

const zero32 = new Uint8Array(32)
const sys = (n: number) => new Uint8Array(32).fill(n)

describe('deriveBotPrivateKey', () => {
  it('produces a valid 32-byte private key', () => {
    const key = deriveBotPrivateKey('mash the keyboard aaaa', sys(7))
    expect(key).toMatch(/^0x[a-f0-9]{64}$/)
    expect(() => privateKeyToAccount(key)).not.toThrow()
  })

  it('is deterministic for the same inputs', () => {
    expect(deriveBotPrivateKey('abc', sys(1))).toBe(deriveBotPrivateKey('abc', sys(1)))
  })

  it('different user entropy → different key', () => {
    expect(deriveBotPrivateKey('abc', sys(1))).not.toBe(deriveBotPrivateKey('abd', sys(1)))
  })

  it('different system entropy → different key (never weaker than CSPRNG)', () => {
    expect(deriveBotPrivateKey('abc', sys(1))).not.toBe(deriveBotPrivateKey('abc', sys(2)))
  })

  it('rejects empty entropy from both sources', () => {
    expect(() => deriveBotPrivateKey('', zero32)).toThrow(/no entropy/)
  })
})
