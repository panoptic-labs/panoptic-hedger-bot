import 'dotenv/config'

import { parseHedgerBotConfig } from '../src/config'
import { buildActivationMarker, writeActivation } from '../src/runtime/activation'
import { runDoctorChecks } from './lib/diagnostics/checks'
import { buildDiagnosticsContext } from './lib/diagnostics/context'
import { renderDoctor } from './lib/diagnostics/render'
import { Prompter } from './lib/prompts'

/**
 * Deliberate go-live step: runs the full preflight, and only on an all-pass
 * result (plus explicit confirmation) writes the activation marker that lets
 * `pnpm start` trade for real. Re-run after any config/scope change — the marker
 * is pinned to this Safe/pool/chain.
 *
 * NOTE: `DRY_RUN=true` still forces dry-run even when activated; activation only
 * removes the "not activated" block, it does not override an explicit DRY_RUN.
 */
async function main(): Promise<void> {
  const config = parseHedgerBotConfig()
  const ctx = await buildDiagnosticsContext(config)
  const results = await runDoctorChecks(ctx)
  const ok = renderDoctor(results)

  if (!ok) {
    console.error(
      'Preflight failed — not activating. Fix the ✗ checks above and re-run `pnpm activate`.',
    )
    process.exitCode = 1
    return
  }

  const p = new Prompter()
  let confirmed = false
  try {
    console.log(
      `\n⚠️  This switches the bot to LIVE trading:\n` +
        `    Safe ${config.SAFE_ADDRESS}\n` +
        `    pool ${config.POOL_ADDRESS} on chain ${config.CHAIN_ID}\n` +
        `    The bot will mint/burn real hedge loans against the Safe.\n`,
    )
    if (config.DRY_RUN) {
      console.log(
        '    (Note: DRY_RUN=true is set, so `pnpm start` will still simulate until you unset it.)\n',
      )
    }
    confirmed = await p.confirm('Activate live trading?', false)
  } finally {
    p.close()
  }

  if (!confirmed) {
    console.log('Aborted — no marker written; the bot stays in dry-run.')
    return
  }

  writeActivation(buildActivationMarker(config, true, new Date().toISOString()))
  console.log('\n✓ Activated. Start (or restart) the bot with `pnpm start` to trade live.')
}

main().catch((err) => {
  console.error(err instanceof Error ? (err.stack ?? err.message) : String(err))
  process.exitCode = 1
})
