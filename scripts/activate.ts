import 'dotenv/config'

import path from 'node:path'

import { parseHedgerBotConfig } from '../src/config'
import { sanitizeError } from '../src/utils/sanitize'
import { runGuidedActivation } from './lib/guidedActivation'
import { Prompter } from './lib/prompts'

async function main(): Promise<void> {
  const prompter = new Prompter()
  try {
    const result = await runGuidedActivation({
      config: parseHedgerBotConfig(),
      envPath: path.resolve(process.cwd(), '.env'),
      prompter,
      readOnlyConfig: process.argv.includes('--read-only-config'),
    })
    if (result === 'failed') process.exitCode = 1
  } finally {
    prompter.close()
  }
}

main().catch((error: unknown) => {
  console.error(sanitizeError(error))
  process.exitCode = 1
})
