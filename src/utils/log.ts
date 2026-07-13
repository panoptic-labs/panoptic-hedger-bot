/**
 * Tiny logging helpers that prefix every line with an ISO-8601 UTC timestamp,
 * so the bot's polling output is legible in a long-running log. The existing
 * `[hedger-bot]` tag is kept in the message.
 */

function stamp(): string {
  return new Date().toISOString()
}

export function botLog(message: string): void {
  console.log(`${stamp()} ${message}`)
}

export function botWarn(message: string): void {
  console.warn(`${stamp()} ${message}`)
}

export function botError(message: string, ...rest: unknown[]): void {
  console.error(`${stamp()} ${message}`, ...rest)
}
