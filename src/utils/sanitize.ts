const MAX_TEXT_LENGTH = 480
const MAX_CAUSE_DEPTH = 2

const URL_PATTERN = /\bhttps?:\/\/[^\s"'<>]+/giu
const TELEGRAM_TOKEN_PATTERN = /bot\d{6,}:[A-Za-z0-9_-]{20,}\b/gu
const AUTHORIZATION_PATTERN = /\b(authorization|proxy-authorization)\s*[:=]\s*[^,;\r\n]+/giu
const SECRET_ASSIGNMENT_PATTERN =
  /(api[_-]?key|token|secret|password|passphrase|private[_-]?key)\s*[:=]\s*[^,;\s}\]]+/giu
const LONG_HEX_PATTERN = /\b0x[a-fA-F0-9]{130,}\b/gu
const REQUEST_BODY_PATTERN =
  /\b(body|requestBody|serializedTransaction|rawTransaction)\s*[:=]\s*[^\r\n]+/giu

function bounded(value: string, limit = MAX_TEXT_LENGTH): string {
  if (value.length <= limit) return value
  return `${value.slice(0, limit - 12)}…[truncated]`
}

function sanitizeUrl(raw: string): string {
  try {
    const url = new URL(raw)
    const port = url.port ? `:${url.port}` : ''
    return `${url.protocol}//${url.hostname}${port}/[redacted]`
  } catch {
    return '[redacted-url]'
  }
}

export function sanitizeText(value: string, limit = MAX_TEXT_LENGTH): string {
  const redacted = value
    .replace(TELEGRAM_TOKEN_PATTERN, 'bot[redacted]')
    .replace(AUTHORIZATION_PATTERN, '$1: [redacted]')
    .replace(REQUEST_BODY_PATTERN, '$1=[redacted]')
    .replace(SECRET_ASSIGNMENT_PATTERN, '$1=[redacted]')
    .replace(LONG_HEX_PATTERN, '0x[redacted-transaction]')
    .replace(URL_PATTERN, sanitizeUrl)
  return bounded(redacted, limit)
}

function ownString(value: unknown, key: string): string | undefined {
  if (typeof value !== 'object' || value === null) return undefined
  const descriptor = Object.getOwnPropertyDescriptor(value, key)
  return typeof descriptor?.value === 'string' ? descriptor.value : undefined
}

function ownValue(value: unknown, key: string): unknown {
  if (typeof value !== 'object' || value === null) return undefined
  return Object.getOwnPropertyDescriptor(value, key)?.value
}

function errorSummary(error: unknown, depth: number): string {
  if (typeof error === 'string') return sanitizeText(error)
  if (typeof error !== 'object' || error === null) return sanitizeText(String(error))

  const name = ownString(error, 'name')
  const shortMessage = ownString(error, 'shortMessage')
  const message = shortMessage ?? ownString(error, 'message')
  const parts = [name, message].filter((part): part is string => Boolean(part))
  const summary = sanitizeText(parts.length > 0 ? parts.join(': ') : 'Unknown error')

  if (depth >= MAX_CAUSE_DEPTH) return summary
  const cause = ownValue(error, 'cause')
  if (cause === undefined || cause === error) return summary
  return bounded(`${summary}; cause: ${errorSummary(cause, depth + 1)}`)
}

export function sanitizeError(error: unknown): string {
  return errorSummary(error, 0)
}

export const SANITIZED_ERROR_MAX_LENGTH = MAX_TEXT_LENGTH
export const SANITIZED_ERROR_MAX_CAUSE_DEPTH = MAX_CAUSE_DEPTH
