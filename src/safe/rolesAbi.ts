/**
 * Minimal ABI for the Zodiac Roles Modifier **v2**.
 *
 * We only need the runtime entrypoint the bot uses (`execTransactionWithRole`)
 * plus a few view functions for startup preflight. The full Roles v2 ABI is
 * large; keeping a hand-written slice avoids pulling the whole zodiac package
 * into the bot runtime.
 *
 * Roles v2 `execTransactionWithRole`:
 *   function execTransactionWithRole(
 *     address to,
 *     uint256 value,
 *     bytes data,
 *     uint8 operation,      // Enum.Operation: 0 = Call, 1 = DelegateCall
 *     bytes32 roleKey,
 *     bool shouldRevert
 *   ) returns (bool success)
 *
 * `avatar()` / `target()` are inherited from the Zodiac `Modifier` base: for a
 * correctly-wired modifier both return the Safe address (avatar = the account
 * whose state is read, target = the account transactions are relayed to).
 */
export const rolesModifierV2Abi = [
  {
    type: 'function',
    name: 'execTransactionWithRole',
    stateMutability: 'nonpayable',
    inputs: [
      { name: 'to', type: 'address' },
      { name: 'value', type: 'uint256' },
      { name: 'data', type: 'bytes' },
      { name: 'operation', type: 'uint8' },
      { name: 'roleKey', type: 'bytes32' },
      { name: 'shouldRevert', type: 'bool' },
    ],
    outputs: [{ name: 'success', type: 'bool' }],
  },
  {
    type: 'function',
    name: 'avatar',
    stateMutability: 'view',
    inputs: [],
    outputs: [{ name: '', type: 'address' }],
  },
  {
    type: 'function',
    name: 'target',
    stateMutability: 'view',
    inputs: [],
    outputs: [{ name: '', type: 'address' }],
  },
  {
    type: 'function',
    name: 'owner',
    stateMutability: 'view',
    inputs: [],
    outputs: [{ name: '', type: 'address' }],
  },
] as const

/** Zodiac `Enum.Operation`. The bot only ever performs plain calls. */
export const ROLES_OPERATION = {
  Call: 0,
  DelegateCall: 1,
} as const
