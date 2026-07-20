import { mkdtempSync, readFileSync, rmSync } from 'node:fs'
import { tmpdir } from 'node:os'
import path from 'node:path'

import { afterEach, describe, expect, it } from 'vitest'

import { writeSecureJson } from '../../src/runtime/secureFile'
import { encryptKeystore, keystoreV3Schema } from '../../src/utils/keystore'
import { loadKeystorePrivateKey } from './loadKeystorePrivateKey'

const temporaryDirectories: string[] = []

afterEach(() => {
  for (const directory of temporaryDirectories.splice(0)) {
    rmSync(directory, { recursive: true, force: true })
  }
})

describe('loadKeystorePrivateKey', () => {
  it('retries a wrong passphrase and leaves the encrypted keystore unchanged', async () => {
    const directory = mkdtempSync(path.join(tmpdir(), 'hedger-keystore-test-'))
    temporaryDirectories.push(directory)
    const target = path.join(directory, 'bot-keystore.json')
    const privateKey = '0x1111111111111111111111111111111111111111111111111111111111111111'
    const passphrase = 'synthetic-passphrase'
    writeSecureJson(target, keystoreV3Schema, encryptKeystore(privateKey, passphrase))
    const before = readFileSync(target, 'utf8')
    const answers = ['incorrect-passphrase', passphrase][Symbol.iterator]()
    let mismatches = 0

    const loaded = await loadKeystorePrivateKey(
      target,
      async () => {
        const answer = answers.next()
        if (answer.done) throw new Error('test exhausted passphrases')
        return answer.value
      },
      () => {
        mismatches += 1
      },
    )

    expect(loaded).toBe(privateKey)
    expect(mismatches).toBe(1)
    expect(readFileSync(target, 'utf8')).toBe(before)
  })
})
