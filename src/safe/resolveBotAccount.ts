import { readFile } from 'node:fs/promises'
import { createInterface } from 'node:readline/promises'
import { Writable } from 'node:stream'

import type { Account } from 'viem'
import { privateKeyToAccount } from 'viem/accounts'

import type { HedgerBotConfig } from '../config'
import { type KeystoreV3, decryptKeystore } from '../utils/keystore'

/**
 * Resolve the bot signing account from config. Either `BOT_PRIVATE_KEY` (raw
 * hex) or `BOT_KEYSTORE_PATH` (a passphrase-encrypted v3 keystore) is set — the
 * config schema guarantees exactly one. For a keystore the passphrase comes
 * from `BOT_KEYSTORE_PASSPHRASE` if set (unattended restart), otherwise it is
 * prompted for interactively (masked).
 */
export async function resolveBotAccount(config: HedgerBotConfig): Promise<Account> {
  if (config.BOT_PRIVATE_KEY) {
    return privateKeyToAccount(config.BOT_PRIVATE_KEY)
  }

  const path = config.BOT_KEYSTORE_PATH
  if (!path) {
    // Unreachable given the config superRefine, but fail loudly if it changes.
    throw new Error('No bot key source: set BOT_PRIVATE_KEY or BOT_KEYSTORE_PATH')
  }

  let keystore: KeystoreV3
  try {
    keystore = JSON.parse(await readFile(path, 'utf8')) as KeystoreV3
  } catch (err) {
    throw new Error(
      `Could not read bot keystore at ${path}: ${err instanceof Error ? err.message : String(err)}`,
    )
  }

  const passphrase = config.BOT_KEYSTORE_PASSPHRASE ?? (await promptPassphrase(path))
  const privateKey = decryptKeystore(keystore, passphrase)
  return privateKeyToAccount(privateKey)
}

/** Prompt for a keystore passphrase on the TTY with masked input. */
async function promptPassphrase(path: string): Promise<string> {
  let muted = false
  const output = new Writable({
    write: (chunk, _enc, cb) => {
      if (!muted) process.stdout.write(chunk)
      cb()
    },
  })
  const rl = createInterface({ input: process.stdin, output, terminal: true })
  try {
    process.stdout.write(`Passphrase for bot keystore (${path}): `)
    muted = true
    const answer = await rl.question('')
    muted = false
    process.stdout.write('\n')
    return answer
  } finally {
    rl.close()
  }
}
