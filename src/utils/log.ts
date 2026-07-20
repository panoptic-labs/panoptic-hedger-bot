import { sanitizeError, sanitizeText } from './sanitize'

/**
 * Tiny logging helpers that prefix every line with an ISO-8601 UTC timestamp,
 * so the bot's polling output is legible in a long-running log. The existing
 * `[hedger-bot]` tag is kept in the message.
 */

function stamp(): string {
  return new Date().toISOString()
}

export function botLog(message: string): void {
  console.log(`${stamp()} ${sanitizeText(message, 4_000)}`)
}

export function botWarn(message: string): void {
  console.warn(`${stamp()} ${sanitizeText(message, 4_000)}`)
}

export function botError(message: string, ...rest: unknown[]): void {
  const details = rest.map(sanitizeError).filter(Boolean)
  console.error(
    `${stamp()} ${sanitizeText(message, 4_000)}${details.length ? `: ${details.join('; ')}` : ''}`,
  )
}
