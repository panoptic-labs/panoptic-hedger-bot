import {
  createCipheriv,
  createDecipheriv,
  pbkdf2Sync,
  randomBytes,
  randomUUID,
  scryptSync,
  timingSafeEqual,
} from 'node:crypto'

import { type Hex, keccak256 } from 'viem'
import { privateKeyToAccount } from 'viem/accounts'

/**
 * Web3 Secret Storage v3 (geth-style) passphrase-encrypted keystore for the bot
 * signing key. Implemented directly on node:crypto + viem's keccak256 (no new
 * dependency) so the bot key is never stored in plaintext at rest.
 *
 * Compatible with geth / `cast wallet import` keystores: encryption always uses
 * scrypt; decryption reads the kdf + params from the file and supports both
 * scrypt and pbkdf2.
 */

interface ScryptParams {
  dklen: number
  salt: string
  n: number
  r: number
  p: number
}

interface Pbkdf2Params {
  dklen: number
  salt: string
  c: number
  prf: string
}

export interface KeystoreV3 {
  version: 3
  id: string
  address: string
  crypto: {
    ciphertext: string
    cipherparams: { iv: string }
    cipher: 'aes-128-ctr'
    kdf: 'scrypt' | 'pbkdf2'
    kdfparams: ScryptParams | Pbkdf2Params
    mac: string
  }
}

// geth "standard" scrypt cost — strong, ~256MB transient memory.
const SCRYPT_N = 1 << 18
const SCRYPT_R = 8
const SCRYPT_P = 1
const DKLEN = 32

const hexToBuf = (hex: string): Buffer => Buffer.from(hex.replace(/^0x/, ''), 'hex')

/** scrypt maxmem must exceed 128*N*r; give it headroom. */
const scryptMaxmem = (n: number, r: number): number => 256 * n * r + 1024 * 1024

/** Derive the 32-byte key from the passphrase per the keystore's kdf params. */
function deriveKey(passphrase: string, kdf: string, params: ScryptParams | Pbkdf2Params): Buffer {
  const salt = hexToBuf(params.salt)
  if (kdf === 'scrypt') {
    const p = params as ScryptParams
    return scryptSync(passphrase, salt, p.dklen, {
      N: p.n,
      r: p.r,
      p: p.p,
      maxmem: scryptMaxmem(p.n, p.r),
    })
  }
  if (kdf === 'pbkdf2') {
    const p = params as Pbkdf2Params
    if (p.prf !== 'hmac-sha256') throw new Error(`unsupported pbkdf2 prf: ${p.prf}`)
    return pbkdf2Sync(passphrase, salt, p.c, p.dklen, 'sha256')
  }
  throw new Error(`unsupported keystore kdf: ${kdf}`)
}

/** keccak256 MAC over derivedKey[16:32] ++ ciphertext (Web3 Secret Storage). */
function computeMac(derivedKey: Buffer, ciphertext: Buffer): string {
  return keccak256(new Uint8Array(Buffer.concat([derivedKey.subarray(16, 32), ciphertext]))).slice(
    2,
  )
}

/** Encrypt a 0x-prefixed private key into a v3 keystore object. */
export function encryptKeystore(privateKey: Hex, passphrase: string): KeystoreV3 {
  if (!/^0x[a-fA-F0-9]{64}$/.test(privateKey)) {
    throw new Error('encryptKeystore: private key must be 32-byte hex (0x…)')
  }
  const salt = randomBytes(32)
  const iv = randomBytes(16)
  const derivedKey = scryptSync(passphrase, salt, DKLEN, {
    N: SCRYPT_N,
    r: SCRYPT_R,
    p: SCRYPT_P,
    maxmem: scryptMaxmem(SCRYPT_N, SCRYPT_R),
  })
  const cipher = createCipheriv('aes-128-ctr', derivedKey.subarray(0, 16), iv)
  const ciphertext = Buffer.concat([cipher.update(hexToBuf(privateKey)), cipher.final()])
  const address = privateKeyToAccount(privateKey).address.slice(2).toLowerCase()

  return {
    version: 3,
    id: randomUUID(),
    address,
    crypto: {
      ciphertext: ciphertext.toString('hex'),
      cipherparams: { iv: iv.toString('hex') },
      cipher: 'aes-128-ctr',
      kdf: 'scrypt',
      kdfparams: {
        dklen: DKLEN,
        salt: salt.toString('hex'),
        n: SCRYPT_N,
        r: SCRYPT_R,
        p: SCRYPT_P,
      },
      mac: computeMac(derivedKey, ciphertext),
    },
  }
}

/** Decrypt a v3 keystore, returning the 0x-prefixed private key. Throws on a
 * wrong passphrase or tampered file (MAC mismatch). */
export function decryptKeystore(keystore: KeystoreV3, passphrase: string): Hex {
  if (keystore.version !== 3) throw new Error(`unsupported keystore version: ${keystore.version}`)
  const { crypto } = keystore
  if (crypto.cipher !== 'aes-128-ctr') throw new Error(`unsupported cipher: ${crypto.cipher}`)

  const ciphertext = hexToBuf(crypto.ciphertext)
  const derivedKey = deriveKey(passphrase, crypto.kdf, crypto.kdfparams)

  const expectedMac = hexToBuf(computeMac(derivedKey, ciphertext))
  const actualMac = hexToBuf(crypto.mac)
  if (expectedMac.length !== actualMac.length || !timingSafeEqual(expectedMac, actualMac)) {
    throw new Error('keystore MAC mismatch — wrong passphrase or corrupted file')
  }

  const decipher = createDecipheriv(
    'aes-128-ctr',
    derivedKey.subarray(0, 16),
    hexToBuf(crypto.cipherparams.iv),
  )
  const privateKey = Buffer.concat([decipher.update(ciphertext), decipher.final()])
  return `0x${privateKey.toString('hex')}`
}
