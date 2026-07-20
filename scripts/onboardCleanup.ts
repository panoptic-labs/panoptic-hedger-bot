import { existsSync } from 'node:fs'
import path from 'node:path'

import { removeSecureFile } from '../src/runtime/secureFile'
import { sanitizeError } from '../src/utils/sanitize'

const files = ['deploy-state.json', 'bot-keystore.json'].map((name) =>
  path.resolve(process.cwd(), name),
)
const existing = files.filter(existsSync)

if (existing.length === 0) {
  console.log('No onboarding resume artifacts are present.')
  process.exit(0)
}

console.log(
  `Onboarding resume artifacts present: ${existing.map((file) => path.basename(file)).join(', ')}`,
)
if (!process.argv.includes('--confirm')) {
  console.log('No files changed. Re-run with --confirm to remove these owner-controlled artifacts.')
  process.exit(2)
}

try {
  for (const file of existing) removeSecureFile(file)
  console.log('Onboarding resume artifacts removed.')
} catch (error) {
  console.error(sanitizeError(error))
  process.exit(1)
}
