import 'dotenv/config'

import { existsSync } from 'node:fs'
import path from 'node:path'

import { parseHedgerBotConfig } from '../src/config'
import {
  buildActivationEvidence,
  buildActivationMarker,
  writeActivation,
} from '../src/runtime/activation'
import { clearDeactivation } from '../src/runtime/deactivation'
import { readSecureText, writeSecureText } from '../src/runtime/secureFile'
import { sanitizeError } from '../src/utils/sanitize'
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
 * Activation also strips any `DRY_RUN` line from `.env` so `pnpm start` goes
 * live right after — the onboard wizard sets `DRY_RUN=true`, and requiring the
 * operator to hand-delete it (activation alone used to leave it in place) was a
 * confusing footgun.
 */

/**
 * Remove any `DRY_RUN=…` line from the `.env` at cwd. Returns true if a line was
 * removed. Uses the secure (0600) writer so a plaintext BOT_PRIVATE_KEY in the
 * same file keeps its restrictive permissions.
 */
function removeDryRunFromEnv(envPath: string): boolean {
  if (!existsSync(envPath)) return false
  const body = readSecureText(envPath, 1_048_576)
  const lines = body.split('\n')
  const kept = lines.filter((line) => !/^\s*DRY_RUN\s*=/.test(line))
  if (kept.length === lines.length) return false
  writeSecureText(envPath, kept.join('\n'))
  return true
}

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
  if (!ctx.botAddress) {
    throw new Error('Preflight did not resolve the bot public address; refusing activation')
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
        '    (Note: DRY_RUN=true is set — activation will remove it from .env so `pnpm start` goes live.)\n',
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

  const evidence = await buildActivationEvidence(ctx.publicClient, config)
  writeActivation(
    buildActivationMarker(config, ctx.botAddress, evidence, true, new Date().toISOString()),
  )
  clearDeactivation()

  // Strip DRY_RUN so `pnpm start` trades live immediately after activation —
  // otherwise a leftover DRY_RUN=true from onboarding would silently keep the
  // bot simulating even though it is "activated".
  const envPath = path.resolve(process.cwd(), '.env')
  try {
    if (removeDryRunFromEnv(envPath)) {
      console.log('✓ Removed DRY_RUN from .env — `pnpm start` will now trade live.')
    }
  } catch (err) {
    // Already activated — a failure to rewrite .env must not fail the run.
    console.warn(
      `  ⚠️  Activated, but could not auto-remove DRY_RUN from .env (${sanitizeError(err)}).\n` +
        '      Delete the DRY_RUN line manually so `pnpm start` trades live.',
    )
  }

  console.log('\n✅ Activated. Start (or restart) the bot with `pnpm start` to trade live.')
}

main().catch((err) => {
  console.error(sanitizeError(err))
  process.exitCode = 1
})
