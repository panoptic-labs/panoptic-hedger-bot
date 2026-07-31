import { mkdtempSync, readFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import path from 'node:path'

import { describe, expect, it } from 'vitest'

import { writeSecureText } from '../../src/runtime/secureFile'
import { updateEnvFile } from './envFile'

describe('updateEnvFile', () => {
  it('updates selected values while preserving secrets and appending missing keys', () => {
    const directory = mkdtempSync(path.join(tmpdir(), 'hedger-env-update-'))
    const envPath = path.join(directory, '.env')
    writeSecureText(envPath, 'BOT_PRIVATE_KEY=secret\nDRY_RUN=false\n')

    updateEnvFile(envPath, {
      DRY_RUN: true,
      SFPM_SWAP_ENABLED: false,
    })

    expect(readFileSync(envPath, 'utf8')).toContain('BOT_PRIVATE_KEY=secret')
    expect(readFileSync(envPath, 'utf8')).toContain('DRY_RUN=true')
    expect(readFileSync(envPath, 'utf8')).toContain('SFPM_SWAP_ENABLED=false')
  })
})
