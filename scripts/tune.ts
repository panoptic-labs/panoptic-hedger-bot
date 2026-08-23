import { existsSync } from 'node:fs'
import path from 'node:path'
import { fileURLToPath } from 'node:url'

import { parseHedgerBotConfig } from '../src/config'
import { readSecureText } from '../src/runtime/secureFile'
import { sanitizeError } from '../src/utils/sanitize'
import { updateEnvFile } from './lib/envFile'
import { Prompter } from './lib/prompts'
import { diffTuneAnswers, dotenvObject, TUNE_KNOBS } from './lib/tuneKnobs'

/**
 * `pnpm tune` — re-prompt the strategy/gas/cadence knobs with the current
 * effective values as defaults and patch `.env` in place. Touches nothing
 * on-chain and never changes the permission surface (DRY_RUN, activation, and
 * SFPM provisioning stay exactly as they are), so it needs no repair or
 * re-activation permissions. Strategy changes do invalidate the activation
 * fingerprint and therefore require inspection followed by `pnpm activate`.
 *
 * For permission changes (adding the SFPM venue or deleverager role, replacing
 * the Roles modifier), run `pnpm onboard` instead — with an existing `.env` it
 * enters guided repair.
 */
export async function runTune(
  envPath: string,
  p: Prompter,
  log: (message: string) => void = console.log,
): Promise<void> {
  if (!existsSync(envPath)) {
    throw new Error('No .env found. Run `pnpm onboard` first — tune only retunes an existing bot.')
  }

  const env = dotenvObject(readSecureText(envPath, 1_048_576))
  let config
  try {
    config = parseHedgerBotConfig(env)
  } catch (err) {
    throw new Error(
      `The existing .env does not validate — repair it with \`pnpm onboard\` before tuning.\n` +
        sanitizeError(err),
    )
  }

  log(
    '\n Hedger-bot tune — strategy/gas/cadence only. Enter keeps the shown value.\n' +
      ' (Permissions and DRY_RUN are untouched. A changed policy requires fresh inspection and activation.)\n',
  )

  const knobs = TUNE_KNOBS.filter((knob) => knob.applies?.(config) ?? true)
  // Seed defaults from the current effective config; on a validation retry
  // the defaults become the operator's previous answers.
  const answers: Record<string, string> = {}
  const currents: Record<string, string> = {}
  for (const knob of knobs) currents[knob.key] = knob.current(config)

  for (;;) {
    for (const knob of knobs) {
      const previous = answers[knob.key] ?? currents[knob.key]
      if (knob.kind === 'confirm') {
        answers[knob.key] = String(
          await p.confirm(`${knob.key} (${knob.hint})`, previous === 'true'),
        )
      } else {
        answers[knob.key] = await p.text(`${knob.key} (${knob.hint})`, { default: previous })
      }
    }

    const updates = diffTuneAnswers(env, answers, currents)
    if (Object.keys(updates).length === 0) {
      log('\n Nothing changed.')
      return
    }

    // Validate the whole merged file so cross-field rules (fee-cap ordering,
    // bump-vs-timeout, deleverage trigger < target) are enforced before any
    // write. On failure, loop with the answers as the new defaults.
    try {
      parseHedgerBotConfig({ ...env, ...updates })
    } catch (err) {
      log(`\n ✗ Rejected — nothing written yet:\n${sanitizeError(err)}\n Adjust:\n`)
      continue
    }

    updateEnvFile(envPath, updates)
    log('\n✓ Updated .env:')
    for (const [key, value] of Object.entries(updates)) {
      log(`    ${key}: ${env[key] ?? `(default ${currents[key]})`} → ${value}`)
    }
    log(
      '\n  Strategy changes make the existing activation stale. Inspect the new plan, then run ' +
        '`pnpm activate`; never edit the activation marker directly.',
    )
    return
  }
}

async function main(): Promise<void> {
  const p = new Prompter()
  try {
    await runTune(path.resolve(process.cwd(), '.env'), p)
  } finally {
    p.close()
  }
}

const entrypoint = process.argv[1]
if (entrypoint && fileURLToPath(import.meta.url) === entrypoint) {
  main().catch((err) => {
    console.error(sanitizeError(err))
    process.exit(1)
  })
}
