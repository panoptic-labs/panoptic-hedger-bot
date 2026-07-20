import type { Hex } from 'viem'

import { readSecureJson } from '../../src/runtime/secureFile'
import {
  decryptKeystore,
  isKeystorePassphraseMismatch,
  keystoreV3Schema,
} from '../../src/utils/keystore'

/** Securely load and unlock an existing bot keystore without rewriting it. */
export async function loadKeystorePrivateKey(
  target: string,
  promptPassphrase: () => Promise<string>,
  onPassphraseMismatch: () => void = () => {},
): Promise<Hex> {
  const keystore = readSecureJson(target, keystoreV3Schema, {
    maxBytes: 16_384,
    invalid: 'throw',
  })
  if (!keystore) throw new Error('bot keystore does not exist')

  for (;;) {
    try {
      return decryptKeystore(keystore, await promptPassphrase())
    } catch (error) {
      if (!isKeystorePassphraseMismatch(error)) throw error
      onPassphraseMismatch()
    }
  }
}
