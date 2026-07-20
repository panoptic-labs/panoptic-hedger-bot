import 'dotenv/config'

import { parseHedgerBotConfig } from '../src/config'
import { sanitizeError } from '../src/utils/sanitize'
import { buildStatusDiagnosticsContext } from './lib/diagnostics/context'
import { renderStatus } from './lib/diagnostics/render'
import { gatherStatus } from './lib/diagnostics/status'

/**
 * Operator snapshot: running-state, mode (live/dry-run, activation-aware),
 * chain/pool/Safe wiring, bot gas, positions + net delta, price-source health,
 * and last poll/hedge from the runtime heartbeat. Read-only.
 */
async function main(): Promise<void> {
  let config
  try {
    config = parseHedgerBotConfig()
  } catch (err) {
    console.error(sanitizeError(err))
    process.exitCode = 1
    return
  }

  const ctx = await buildStatusDiagnosticsContext(config)
  renderStatus(await gatherStatus(ctx))
}

main().catch((err) => {
  console.error(sanitizeError(err))
  process.exitCode = 1
})
