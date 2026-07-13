import { type Hex, concat, keccak256, toBytes } from 'viem'
import { privateKeyToAccount } from 'viem/accounts'

/**
 * Derive a bot private key from user-typed entropy mixed with system CSPRNG
 * entropy. The result is `keccak256(utf8(userEntropy) || systemEntropy)`,
 * re-hashed on the astronomically-unlikely chance the value is outside the
 * secp256k1 range.
 *
 * Mixing the CSPRNG bytes means the key is never weaker than viem's
 * `generatePrivateKey()`: the user's typed randomness is added on top of the
 * machine's, not used in its place. Pass an all-zero `systemEntropy` only if a
 * pure user-entropy key is explicitly wanted (not recommended).
 */
export function deriveBotPrivateKey(userEntropy: string, systemEntropy: Uint8Array): Hex {
  if (userEntropy.length === 0 && systemEntropy.every((b) => b === 0)) {
    throw new Error('deriveBotPrivateKey: no entropy provided')
  }
  let key = keccak256(concat([toBytes(userEntropy), systemEntropy]))
  // Reject a key of 0 or >= curve order (privateKeyToAccount throws); re-hash.
  for (;;) {
    try {
      privateKeyToAccount(key)
      return key
    } catch {
      key = keccak256(key)
    }
  }
}
