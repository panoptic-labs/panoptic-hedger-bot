import 'dotenv/config'

import { parseHedgerBotConfig } from '../src/config'
import { runDoctorChecks } from './lib/diagnostics/checks'
import { buildDiagnosticsContext } from './lib/diagnostics/context'
import { renderDoctor } from './lib/diagnostics/render'

/**
 * Read-only preflight: validates config, connectivity, contract wiring, roles
 * scope, keys, price sanity, gas, and Telegram — every check pass/fail with a
 * remedy. Never sends a state-changing transaction. Exits non-zero on any fail
 * so it can gate `activate` and CI.
 *
 * Flags: --telegram-test sends a real Telegram message (off by default).
 */
async function main(): Promise<void> {
  let config
  try {
    config = parseHedgerBotConfig()
  } catch (err) {
    console.error(err instanceof Error ? err.message : String(err))
    process.exitCode = 1
    return
  }

  const ctx = await buildDiagnosticsContext(config)
  const results = await runDoctorChecks(ctx, {
    sendTelegram: process.argv.includes('--telegram-test'),
  })
  const ok = renderDoctor(results)
  // exitCode (not exit()) so buffered stdout flushes before the process ends.
  process.exitCode = ok ? 0 : 1
}

main().catch((err) => {
  console.error(err instanceof Error ? (err.stack ?? err.message) : String(err))
  process.exitCode = 1
})
