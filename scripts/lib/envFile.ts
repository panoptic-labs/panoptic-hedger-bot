import { readSecureText, writeSecureText } from '../../src/runtime/secureFile'

export type EnvFileValue = string | number | bigint | boolean

/**
 * Update generated configuration without exposing or rebuilding unrelated
 * values such as private keys and notification credentials.
 */
export function updateEnvFile(
  envPath: string,
  updates: Readonly<Record<string, EnvFileValue>>,
): void {
  const lines = readSecureText(envPath, 1_048_576).split('\n')
  const pending = new Map(Object.entries(updates))
  const rewritten = lines.map((line) => {
    const match = /^\s*([A-Z][A-Z0-9_]*)\s*=/.exec(line)
    const key = match?.[1]
    if (!key || !pending.has(key)) return line
    const value = pending.get(key)
    pending.delete(key)
    return `${key}=${String(value)}`
  })
  if (pending.size > 0) {
    if (rewritten[rewritten.length - 1] !== '') rewritten.push('')
    rewritten.push('# Updated by the guided hedger-bot setup')
    for (const [key, value] of pending) rewritten.push(`${key}=${String(value)}`)
    rewritten.push('')
  }
  writeSecureText(envPath, rewritten.join('\n'))
}
