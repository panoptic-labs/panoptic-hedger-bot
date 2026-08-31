import { existsSync, readFileSync } from 'node:fs'
import path from 'node:path'

const docs = ['README.md', 'runbook.md']
const failures = []
const multiInstanceAssets = [
  'examples/multi-instance/compose.yml',
  'examples/multi-instance/.gitignore',
  'examples/multi-instance/.env.example',
  'examples/multi-instance/instance.env.example',
]

for (const doc of docs) {
  const body = readFileSync(doc, 'utf8')
  for (const match of body.matchAll(/\[[^\]]*\]\(([^)]+)\)/g)) {
    const target = match[1]
    if (!target || target.startsWith('#') || /^[a-z]+:/i.test(target)) continue
    const local = decodeURIComponent(target.split('#')[0] ?? '')
    if (!local || existsSync(path.resolve(path.dirname(doc), local))) continue
    failures.push(`${doc}: missing local link ${local}`)
  }
}

for (const asset of multiInstanceAssets) {
  if (!existsSync(asset)) failures.push(`multi-instance example: missing ${asset}`)
}
if (existsSync('docker-compose.multi.example.yml')) {
  failures.push('multi-instance example: obsolete root-level Compose sample still exists')
}

if (failures.length > 0) {
  for (const failure of failures) console.error(failure)
  process.exit(1)
}
console.log('Documentation local-link check passed.')
