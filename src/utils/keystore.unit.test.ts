import { generatePrivateKey, privateKeyToAccount } from 'viem/accounts'
import { describe, expect, it } from 'vitest'

import {
  type KeystoreV3,
  decryptKeystore,
  encryptKeystore,
  isKeystorePassphraseMismatch,
  parseKeystoreEnvelope,
} from './keystore'

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

  it('retries only MAC mismatches, not address-consistency or corruption errors', () => {
    expect(isKeystorePassphraseMismatch(new Error('keystore MAC mismatch'))).toBe(true)
    expect(isKeystorePassphraseMismatch(new Error('keystore address does not match'))).toBe(false)
    expect(isKeystorePassphraseMismatch(new Error('invalid ciphertext'))).toBe(false)
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

  it('rejects excessive or weak KDF parameters before derivation', () => {
    const ks = encryptKeystore(key, pass)
    expect(() =>
      parseKeystoreEnvelope({
        ...ks,
        crypto: { ...ks.crypto, kdfparams: { ...ks.crypto.kdfparams, n: 2 ** 24 } },
      }),
    ).toThrow()
    expect(() =>
      parseKeystoreEnvelope({
        ...ks,
        crypto: { ...ks.crypto, kdfparams: { ...ks.crypto.kdfparams, n: 2 ** 10 } },
      }),
    ).toThrow()
  })

  it('rejects an envelope address that differs from the decrypted key', () => {
    const ks = encryptKeystore(key, pass)
    const other = privateKeyToAccount(generatePrivateKey()).address.slice(2)
    expect(() => decryptKeystore({ ...ks, address: other }, pass)).toThrow(/address does not match/)
  })

  it('rejects malformed ciphertext and trailing unknown fields', () => {
    const ks = encryptKeystore(key, pass)
    expect(() => parseKeystoreEnvelope({ ...ks, surprise: true })).toThrow()
    expect(() =>
      parseKeystoreEnvelope({ ...ks, crypto: { ...ks.crypto, ciphertext: '00' } }),
    ).toThrow()
  })
})
