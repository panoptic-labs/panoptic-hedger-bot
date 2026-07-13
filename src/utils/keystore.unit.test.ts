import { generatePrivateKey, privateKeyToAccount } from 'viem/accounts'
import { describe, expect, it } from 'vitest'

import { type KeystoreV3, decryptKeystore, encryptKeystore } from './keystore'

describe('keystore (Web3 Secret Storage v3)', () => {
  const key = generatePrivateKey()
  const pass = 'correct horse battery staple'

  it('round-trips a private key through encrypt/decrypt', () => {
    const ks = encryptKeystore(key, pass)
    expect(ks.version).toBe(3)
    expect(ks.crypto.kdf).toBe('scrypt')
    // Address recorded matches the key, sans 0x, lowercased.
    expect(`0x${ks.address}`).toBe(privateKeyToAccount(key).address.toLowerCase())
    expect(decryptKeystore(ks, pass)).toBe(key)
  })

  it('does not store the raw key anywhere in the file', () => {
    const ks = encryptKeystore(key, pass)
    expect(JSON.stringify(ks)).not.toContain(key.slice(2))
  })

  it('throws on a wrong passphrase (MAC mismatch)', () => {
    const ks = encryptKeystore(key, pass)
    expect(() => decryptKeystore(ks, 'wrong')).toThrow(/MAC mismatch/)
  })

  it('throws on a tampered ciphertext', () => {
    const ks = encryptKeystore(key, pass)
    const flipped = ks.crypto.ciphertext.startsWith('00') ? '11' : '00'
    const tampered: KeystoreV3 = {
      ...ks,
      crypto: { ...ks.crypto, ciphertext: flipped + ks.crypto.ciphertext.slice(2) },
    }
    expect(() => decryptKeystore(tampered, pass)).toThrow(/MAC mismatch/)
  })

  it('rejects a non-hex private key', () => {
    expect(() => encryptKeystore('0xnothex' as `0x${string}`, pass)).toThrow(/32-byte hex/)
  })
})
