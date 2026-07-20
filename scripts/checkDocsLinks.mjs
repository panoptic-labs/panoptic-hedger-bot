import { existsSync, readFileSync } from 'node:fs'
import path from 'node:path'

const docs = ['README.md', 'runbook.md']
const failures = []

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

if (failures.length > 0) {
  for (const failure of failures) console.error(failure)
  process.exit(1)
}
console.log('Documentation local-link check passed.')
