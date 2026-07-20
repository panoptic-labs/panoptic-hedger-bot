import {
  createCipheriv,
  createDecipheriv,
  pbkdf2Sync,
  randomBytes,
  randomUUID,
  scryptSync,
  timingSafeEqual,
} from 'node:crypto'

import { type Hex, getAddress, keccak256, toHex } from 'viem'
import { privateKeyToAccount } from 'viem/accounts'
import { z } from 'zod'

/**
 * Web3 Secret Storage v3 (geth-style) passphrase-encrypted keystore for the bot
 * signing key. Implemented directly on node:crypto + viem's keccak256 (no new
 * dependency) so the bot key is never stored in plaintext at rest.
 *
 * Compatible with geth / `cast wallet import` keystores: encryption always uses
 * scrypt; decryption reads the kdf + params from the file and supports both
 * scrypt and pbkdf2.
 */

const hex = (bytes: number) => z.string().regex(new RegExp(`^[0-9a-fA-F]{${bytes * 2}}$`))
const common = {
  dklen: z.literal(32),
  salt: hex(32),
}
const scryptParamsSchema = z
  .object({
    ...common,
    n: z
      .number()
      .int()
      .min(1 << 14)
      .max(1 << 20)
      .refine((value) => (value & (value - 1)) === 0, 'scrypt n must be a power of two'),
    r: z.number().int().min(8).max(16),
    p: z.number().int().min(1).max(4),
  })
  .strict()
const pbkdf2ParamsSchema = z
  .object({
    ...common,
    c: z.number().int().min(262_144).max(2_000_000),
    prf: z.literal('hmac-sha256'),
  })
  .strict()
const cryptoCommon = {
  ciphertext: hex(32),
  cipherparams: z.object({ iv: hex(16) }).strict(),
  cipher: z.literal('aes-128-ctr'),
  mac: hex(32),
}
export const keystoreV3Schema = z
  .object({
    version: z.literal(3),
    id: z.string().uuid(),
    address: hex(20),
    crypto: z.discriminatedUnion('kdf', [
      z
        .object({ ...cryptoCommon, kdf: z.literal('scrypt'), kdfparams: scryptParamsSchema })
        .strict(),
      z
        .object({ ...cryptoCommon, kdf: z.literal('pbkdf2'), kdfparams: pbkdf2ParamsSchema })
        .strict(),
    ]),
  })
  .strict()
export type KeystoreV3 = z.infer<typeof keystoreV3Schema>

export function parseKeystoreEnvelope(value: unknown): KeystoreV3 {
  return keystoreV3Schema.parse(value)
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
function deriveKey(passphrase: string, crypto: KeystoreV3['crypto']): Buffer {
  const salt = hexToBuf(crypto.kdfparams.salt)
  if (crypto.kdf === 'scrypt') {
    const params = crypto.kdfparams
    return scryptSync(passphrase, salt, params.dklen, {
      N: params.n,
      r: params.r,
      p: params.p,
      maxmem: scryptMaxmem(params.n, params.r),
    })
  }
  return pbkdf2Sync(passphrase, salt, crypto.kdfparams.c, crypto.kdfparams.dklen, 'sha256')
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
  const validated = parseKeystoreEnvelope(keystore)
  const { crypto } = validated

  const ciphertext = hexToBuf(crypto.ciphertext)
  const derivedKey = deriveKey(passphrase, crypto)

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
  const privateKey = toHex(Buffer.concat([decipher.update(ciphertext), decipher.final()]))
  const actualAddress = privateKeyToAccount(privateKey).address
  const envelopeAddress = getAddress(`0x${validated.address}`)
  if (actualAddress !== envelopeAddress) {
    throw new Error('keystore address does not match decrypted private key')
  }
  return privateKey
}

/** Only MAC mismatches are eligible for an interactive passphrase retry. */
export function isKeystorePassphraseMismatch(error: unknown): boolean {
  return error instanceof Error && error.message.includes('keystore MAC mismatch')
}
