import { chmodSync, mkdirSync, mkdtempSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import path from 'node:path'

import { describe, expect, it } from 'vitest'

import { checkMultiInstanceDirectory } from './multiInstance'

const SOURCE_SHA = 'a'.repeat(40)

function address(byte: string): string {
  return `0x${byte.repeat(40)}`
}

function validEnv(overrides: Record<string, string> = {}): string {
  return Object.entries({
    CHAIN_ID: '1',
    RPC_URL: 'https://rpc.example',
    POOL_ADDRESS: address('1'),
    SAFE_ADDRESS: address('2'),
    ROLES_MODIFIER_ADDRESS: address('3'),
    ROLE_KEY: `0x${'44'.repeat(32)}`,
    ASSET_INDEX: '1',
    DRY_RUN: 'false',
    ...overrides,
  })
    .map(([key, value]) => `${key}=${value}`)
    .join('\n')
}

function keystore(signer: string): string {
  return JSON.stringify({
    version: 3,
    id: '00000000-0000-4000-8000-000000000000',
    address: signer.slice(2),
    crypto: {
      ciphertext: '00'.repeat(32),
      cipherparams: { iv: '00'.repeat(16) },
      cipher: 'aes-128-ctr',
      kdf: 'scrypt',
      kdfparams: {
        dklen: 32,
        salt: '00'.repeat(32),
        n: 1 << 14,
        r: 8,
        p: 1,
      },
      mac: '00'.repeat(32),
    },
  })
}

function createOps(sourceSha = SOURCE_SHA): string {
  const directory = mkdtempSync(path.join(tmpdir(), 'hedger-multi-'))
  writeFileSync(path.join(directory, '.env'), `SOURCE_SHA=${sourceSha}\n`)
  return directory
}

function addInstance(
  opsDirectory: string,
  name: string,
  options: {
    signer?: string
    env?: Record<string, string>
    omit?: 'keystore' | 'passphrase'
    secretMode?: number
  } = {},
): void {
  const directory = path.join(opsDirectory, name)
  mkdirSync(directory)
  writeFileSync(path.join(directory, 'hedger.env'), `${validEnv(options.env)}\n`)
  if (options.omit !== 'keystore') {
    const target = path.join(directory, 'bot-keystore.json')
    writeFileSync(target, keystore(options.signer ?? address('5')), {
      mode: options.secretMode ?? 0o600,
    })
    chmodSync(target, options.secretMode ?? 0o600)
  }
  if (options.omit !== 'passphrase') {
    const target = path.join(directory, 'bot-keystore-passphrase')
    writeFileSync(target, 'test-passphrase\n', { mode: options.secretMode ?? 0o600 })
    chmodSync(target, options.secretMode ?? 0o600)
  }
}

describe('multi-instance operations validation', () => {
  it('accepts valid configuration and reports only public identities', () => {
    const ops = createOps()
    addInstance(ops, 'instance-a')

    expect(checkMultiInstanceDirectory(ops)).toEqual({
      sourceSha: SOURCE_SHA,
      instances: [
        expect.objectContaining({
          name: 'instance-a',
          signerAddress: address('5'),
          chainId: 1,
          safeAddress: address('2'),
          poolAddress: address('1'),
          mode: 'live',
        }),
      ],
    })
  })

  it('rejects a malformed image SHA', () => {
    expect(() => checkMultiInstanceDirectory(createOps('abc123'))).toThrow(/40-character/)
  })

  it.each(['keystore', 'passphrase'] as const)('rejects a missing %s file', (omit) => {
    const ops = createOps()
    addInstance(ops, 'instance-a', { omit })
    expect(() => checkMultiInstanceDirectory(ops)).toThrow()
  })

  it('rejects unsafe secret permissions', () => {
    const ops = createOps()
    addInstance(ops, 'instance-a', { secretMode: 0o644 })
    expect(() => checkMultiInstanceDirectory(ops)).toThrow(/owner-only/)
  })

  it('rejects plaintext private keys and passphrases', () => {
    for (const key of ['BOT_PRIVATE_KEY', 'BOT_KEYSTORE_PASSPHRASE']) {
      const ops = createOps()
      addInstance(ops, 'instance-a', { env: { [key]: 'forbidden' } })
      expect(() => checkMultiInstanceDirectory(ops)).toThrow(/forbidden configuration keys/)
    }
  })

  it('rejects Compose-owned runtime path overrides', () => {
    const ops = createOps()
    addInstance(ops, 'instance-a', { env: { HEDGER_STATE_DIR: '/tmp/unsafe' } })
    expect(() => checkMultiInstanceDirectory(ops)).toThrow(/HEDGER_STATE_DIR/)
  })

  it('rejects invalid bot configuration', () => {
    const ops = createOps()
    addInstance(ops, 'instance-a', { env: { CHAIN_ID: 'invalid' } })
    expect(() => checkMultiInstanceDirectory(ops)).toThrow(/Invalid hedger-bot configuration/)
  })

  it('rejects duplicate signer addresses', () => {
    const ops = createOps()
    addInstance(ops, 'instance-a')
    addInstance(ops, 'instance-b', {
      env: { SAFE_ADDRESS: address('6'), POOL_ADDRESS: address('7') },
    })
    expect(() => checkMultiInstanceDirectory(ops)).toThrow(/signer address duplicates/)
  })

  it('rejects duplicate chain+Safe+pool assignments', () => {
    const ops = createOps()
    addInstance(ops, 'instance-a')
    addInstance(ops, 'instance-b', { signer: address('6') })
    expect(() => checkMultiInstanceDirectory(ops)).toThrow(/chain\+Safe\+pool duplicates/)
  })
})
