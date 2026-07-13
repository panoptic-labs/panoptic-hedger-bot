import { readFile } from 'node:fs/promises'
import { createInterface } from 'node:readline/promises'
import { Writable } from 'node:stream'

import { type Account, type Address, getAddress } from 'viem'
import { privateKeyToAccount } from 'viem/accounts'

import type { HedgerBotConfig } from '../config'
import { type KeystoreV3, decryptKeystore } from '../utils/keystore'

/** Read + parse the configured v3 keystore file. Callers guarantee the path is
 * set; a read/parse failure is rewrapped with the path for a clear message. */
async function readKeystore(path: string): Promise<KeystoreV3> {
  try {
    return JSON.parse(await readFile(path, 'utf8')) as KeystoreV3
  } catch (err) {
    throw new Error(
      `Could not read bot keystore at ${path}: ${err instanceof Error ? err.message : String(err)}`,
    )
  }
}

/**
 * Resolve just the bot EOA *address* — no passphrase, no decryption. Read-only
 * callers (`status`, `doctor`) need only the address (keeper gas balance,
 * on-chain scope checks, wiring display) and must NOT trigger the keystore
 * passphrase prompt. A Web3 Secret Storage v3 keystore stores the account
 * address in plaintext, so it is available without unlocking the key.
 */
export async function resolveBotAddress(config: HedgerBotConfig): Promise<Address> {
  if (config.BOT_PRIVATE_KEY) {
    return privateKeyToAccount(config.BOT_PRIVATE_KEY).address
  }
  const path = config.BOT_KEYSTORE_PATH
  if (!path) {
    throw new Error('No bot key source: set BOT_PRIVATE_KEY or BOT_KEYSTORE_PATH')
  }
  const keystore = await readKeystore(path)
  if (!keystore.address || keystore.address.trim() === '') {
    throw new Error(`bot keystore ${path} has no "address" field — is it a valid v3 keystore?`)
  }
  return getAddress(`0x${keystore.address.replace(/^0x/, '')}`)
}

/**
 * Resolve the bot signing account from config. Either `BOT_PRIVATE_KEY` (raw
 * hex) or `BOT_KEYSTORE_PATH` (a passphrase-encrypted v3 keystore) is set — the
 * config schema guarantees exactly one. For a keystore the passphrase comes
 * from `BOT_KEYSTORE_PASSPHRASE` if set (unattended restart); otherwise, when
 * `interactive` (the default), it is prompted for on the TTY (masked). Read-only
 * callers pass `interactive: false` so a missing passphrase throws a clear
 * "locked" error instead of blocking on a prompt.
 */
export async function resolveBotAccount(
  config: HedgerBotConfig,
  opts: { interactive?: boolean } = {},
): Promise<Account> {
  const interactive = opts.interactive ?? true
  if (config.BOT_PRIVATE_KEY) {
    return privateKeyToAccount(config.BOT_PRIVATE_KEY)
  }

  const path = config.BOT_KEYSTORE_PATH
  if (!path) {
    // Unreachable given the config superRefine, but fail loudly if it changes.
    throw new Error('No bot key source: set BOT_PRIVATE_KEY or BOT_KEYSTORE_PATH')
  }

  const keystore = await readKeystore(path)

  let passphrase = config.BOT_KEYSTORE_PASSPHRASE
  if (passphrase === undefined) {
    if (!interactive) {
      throw new Error(
        `bot keystore ${path} is locked — set BOT_KEYSTORE_PASSPHRASE to unlock non-interactively`,
      )
    }
    passphrase = await promptPassphrase(path)
  }
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
