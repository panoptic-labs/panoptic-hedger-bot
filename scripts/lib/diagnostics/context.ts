import type { Account, Address, Chain, PublicClient } from 'viem'
import { createPublicClient, http } from 'viem'

import type { HedgerBotConfig } from '../../../src/config'
import { resolveBotAccount, resolveBotAddress } from '../../../src/safe/resolveBotAccount'
import { defineBotChain } from '../../../src/utils/chain'

/**
 * Shared read-only setup for `doctor` and `status`: builds the chain + public
 * client and resolves the bot identity. These are read-only commands, so they
 * must never block on the keystore passphrase prompt:
 *
 *  - `botAddress` is resolved passphrase-free (v3 keystores store the address in
 *    plaintext) and drives everything read-only needs — keeper gas balance,
 *    on-chain scope checks, wiring display.
 *  - the full signing `account` is resolved only NON-interactively (raw key, or
 *    keystore + `BOT_KEYSTORE_PASSPHRASE`); a locked keystore leaves it
 *    undefined rather than prompting. Both resolutions capture their error so
 *    the remaining reads still run (the key state is itself a doctor check).
 */
export interface DiagnosticsContext {
  config: HedgerBotConfig
  chain: Chain
  publicClient: PublicClient
  /** Bot EOA address — resolved without the passphrase, or undefined if even the
   *  keystore file / key source couldn't be read. */
  botAddress?: Address
  addressError?: unknown
  /** Full signing account, resolved only when possible without prompting;
   *  undefined for a locked keystore. */
  account?: Account
  accountError?: unknown
}

export async function buildDiagnosticsContext(
  config: HedgerBotConfig,
): Promise<DiagnosticsContext> {
  const chain = defineBotChain(config.CHAIN_ID, config.RPC_URL)
  const publicClient = createPublicClient({ chain, transport: http(config.RPC_URL) })

  let botAddress: Address | undefined
  let addressError: unknown
  try {
    botAddress = await resolveBotAddress(config)
  } catch (err) {
    addressError = err
  }

  let account: Account | undefined
  let accountError: unknown
  try {
    account = await resolveBotAccount(config, { interactive: false })
  } catch (err) {
    accountError = err
  }

  return { config, chain, publicClient, botAddress, addressError, account, accountError }
}
