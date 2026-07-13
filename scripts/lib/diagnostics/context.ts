import type { Account, Chain, PublicClient } from 'viem'
import { createPublicClient, http } from 'viem'

import type { HedgerBotConfig } from '../../../src/config'
import { resolveBotAccount } from '../../../src/safe/resolveBotAccount'
import { defineBotChain } from '../../../src/utils/chain'

/**
 * Shared read-only setup for `doctor` and `status`: builds the chain + public
 * client and attempts to resolve the bot account. Account resolution failure
 * (missing/locked keystore) is CAPTURED rather than thrown — it's itself a
 * doctor check — so both commands still run their remaining reads.
 */
export interface DiagnosticsContext {
  config: HedgerBotConfig
  chain: Chain
  publicClient: PublicClient
  /** Resolved bot account, or undefined when the key/keystore couldn't be read. */
  account?: Account
  accountError?: unknown
}

export async function buildDiagnosticsContext(
  config: HedgerBotConfig,
): Promise<DiagnosticsContext> {
  const chain = defineBotChain(config.CHAIN_ID, config.RPC_URL)
  const publicClient = createPublicClient({ chain, transport: http(config.RPC_URL) })

  let account: Account | undefined
  let accountError: unknown
  try {
    account = await resolveBotAccount(config)
  } catch (err) {
    accountError = err
  }

  return { config, chain, publicClient, account, accountError }
}
