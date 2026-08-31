import { existsSync } from 'node:fs'

const entries = [
  'dist/src/main.js',
  'dist/scripts/status.js',
  'dist/scripts/doctor.js',
  'dist/scripts/inspectHedge.js',
  'dist/scripts/activate.js',
  'dist/scripts/deactivate.js',
  'dist/scripts/health.js',
]

const missing = entries.filter((entry) => !existsSync(entry))
if (missing.length > 0) {
  throw new Error(`runtime build is missing compiled entries: ${missing.join(', ')}`)
}
console.log(`Runtime build contains ${entries.length} documented entries.`)
