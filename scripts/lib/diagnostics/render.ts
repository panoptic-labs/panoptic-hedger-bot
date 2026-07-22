import type { CheckStatus, DoctorResult } from './checks'
import type { StatusSnapshot } from './status'

// Minimal ANSI coloring (no dependency). Disabled when not a TTY or NO_COLOR set.
const useColor = process.stdout.isTTY && !process.env.NO_COLOR
const paint = (code: number, s: string): string => (useColor ? `[${code}m${s}[0m` : s)
const dim = (s: string) => paint(2, s)

const MARK: Record<CheckStatus, string> = {
  pass: paint(32, '✓ pass'),
  warn: paint(33, '! warn'),
  fail: paint(31, '✗ FAIL'),
  skip: dim('- skip'),
}

/** Render doctor results; returns true when every check passed (no fails). */
export function renderDoctor(results: DoctorResult[]): boolean {
  console.log('\nHedger-bot preflight (read-only — no transactions sent)\n')
  for (const r of results) {
    console.log(`  ${MARK[r.status]}  ${r.title}`)
    if (r.detail) console.log(dim(`         ${r.detail}`))
    if (r.remedy) console.log(paint(36, `         → ${r.remedy}`))
  }
  const fails = results.filter((r) => r.status === 'fail').length
  const warns = results.filter((r) => r.status === 'warn').length
  console.log(
    `\n${fails === 0 ? paint(32, 'PREFLIGHT OK') : paint(31, `PREFLIGHT FAILED (${fails} fail)`)}` +
      (warns ? paint(33, `, ${warns} warn`) : '') +
      '\n',
  )
  return fails === 0
}

export function renderStatus(s: StatusSnapshot): void {
  const row = (k: string, v: string | number | boolean | undefined) =>
    console.log(`  ${k.padEnd(16)} ${v === undefined ? dim('—') : String(v)}`)
  console.log(`\nHedger-bot status  ${dim(`v${s.version}`)}\n`)
  row('status', s.running)
  row('readiness', s.readiness)
  row(
    'running mode',
    s.runningMode === undefined
      ? '—'
      : s.runningMode === 'live'
        ? paint(31, 'LIVE')
        : paint(33, 'dry-run'),
  )
  row('next start', s.nextStartMode === 'live' ? paint(31, 'LIVE') : paint(33, 'dry-run'))
  row('chain', s.chainId)
  row('pool', `${s.pool}${s.poolPair ? `  ${s.poolPair}` : ''}`)
  row('safe', s.safe)
  row('safe owners', s.safeOwners)
  row('bot', `${s.botAddress ?? '—'}${s.botBalanceEth ? `  ${s.botBalanceEth} ETH` : ''}`)
  row('module', s.moduleEnabled)
  row('loan-only scope', s.loanOnlyScope)
  row('positions', s.positions)
  row('net delta', s.netDelta)
  row('price signal', s.priceSignal)
  row('last poll', s.lastPoll)
  row('last hedge', s.lastHedge)
  row('deleverager', s.deleverager)
  for (const note of s.notes) console.log(paint(33, `  note: ${note}`))
  console.log('')
}
