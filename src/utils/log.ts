import { sanitizeError, sanitizeText } from './sanitize'

/**
 * Tiny logging helpers that prefix every line with an ISO-8601 UTC timestamp,
 * so the bot's polling output is legible in a long-running log. The existing
 * `[hedger-bot]` tag is kept in the message.
 */

function stamp(): string {
  return new Date().toISOString()
}

let transientStatusVisible = false

function clearTransientStatus(): void {
  if (!transientStatusVisible) return
  process.stdout.clearLine(0)
  process.stdout.cursorTo(0)
  transientStatusVisible = false
}

export function botLog(message: string): void {
  clearTransientStatus()
  console.log(`${stamp()} ${sanitizeText(message, 4_000)}`)
}

export function botWarn(message: string): void {
  clearTransientStatus()
  console.warn(`${stamp()} ${sanitizeText(message, 4_000)}`)
}

/** Write a multi-line warning with an identical timestamp prefix on every line. */
export function botWarnBlock(lines: readonly string[]): void {
  clearTransientStatus()
  const timestamp = stamp()
  console.warn(lines.map((line) => `${timestamp} ${sanitizeText(line, 4_000)}`).join('\n'))
}

/** Separate dense log fields into terminal-friendly, tab-aligned columns. */
export function formatLogColumns(heading: string, columns: readonly string[]): string {
  return [heading, ...columns].join('\t| ')
}

/** Frame a short operator message without relying on terminal color support. */
export function formatAsciiBox(tag: string, lines: readonly string[]): string[] {
  const contentWidth = Math.max(...lines.map((line) => line.length), 1)
  const border = `+${'-'.repeat(contentWidth + 2)}+`
  return [
    `${tag} ${border}`,
    ...lines.map((line) => `${tag} | ${line.padEnd(contentWidth)} |`),
    `${tag} ${border}`,
  ]
}

export function botError(message: string, ...rest: unknown[]): void {
  clearTransientStatus()
  const details = rest.map(sanitizeError).filter(Boolean)
  console.error(
    `${stamp()} ${sanitizeText(message, 4_000)}${details.length ? `: ${details.join('; ')}` : ''}`,
  )
}

/** Rewrite one terminal line for high-frequency health data without growing the log. */
export function botStatus(message: string): void {
  if (!process.stdout.isTTY) return
  const line = `${stamp()} ${sanitizeText(message, 4_000)}`
  const width = Math.max(20, (process.stdout.columns ?? 160) - 1)
  process.stdout.clearLine(0)
  process.stdout.cursorTo(0)
  process.stdout.write(line.slice(0, width))
  transientStatusVisible = true
}
