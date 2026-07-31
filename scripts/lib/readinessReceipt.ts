import type { Address } from 'viem'

import type { HedgerBotConfig } from '../../src/config'
import type { HedgeInspectionReceipt } from '../inspectHedge'

export function renderReadinessReceipt(
  config: HedgerBotConfig,
  botAddress: Address,
  inspection: HedgeInspectionReceipt,
): void {
  console.log('\n════════════ READY FOR LIVE HEDGING ════════════')
  console.log(`Safe:              ${config.SAFE_ADDRESS}`)
  console.log(`Pool:              ${config.POOL_ADDRESS} (chain ${config.CHAIN_ID})`)
  console.log(`Bot:               ${botAddress}`)
  console.log(`Roles modifier:    ${config.ROLES_MODIFIER_ADDRESS}`)
  console.log('Bot role:          loan-only (options blocked)')
  console.log(
    `SFPM route:         ${
      config.SFPM_SWAP_ENABLED
        ? `eligible when savings ≥ ${config.SFPM_SWAP_MIN_SAVINGS_BPS} bps`
        : 'disabled'
    }`,
  )
  console.log('Funds:             remain in the Safe')
  console.log(`Dry-run inspection: passed at ${inspection.inspectedAt}`)
  console.log('Activation bound:  this Safe + pool + chain + permission manifest')
  console.log('════════════════════════════════════════════════\n')
}
