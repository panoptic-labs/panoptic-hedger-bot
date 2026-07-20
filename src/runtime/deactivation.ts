import { z } from 'zod'

import { runtimeDataPath } from './paths'
import { readSecureJson, removeSecureFile, writeSecureJson } from './secureFile'

const markerSchema = z
  .object({ version: z.literal(1), deactivatedAt: z.string().datetime() })
  .strict()

export function deactivationPath(): string {
  return process.env.HEDGER_DISABLED_PATH ?? runtimeDataPath('.hedger-disabled.json')
}

export function isDeactivated(): boolean {
  try {
    return (
      readSecureJson(deactivationPath(), markerSchema, {
        maxBytes: 1_024,
        invalid: 'throw',
      }) !== null
    )
  } catch {
    return true
  }
}

export function assertTradingEnabled(): void {
  if (isDeactivated())
    throw new Error('emergency deactivation is active; refusing transaction send')
}

export function writeDeactivation(now = new Date()): void {
  writeSecureJson(deactivationPath(), markerSchema, {
    version: 1,
    deactivatedAt: now.toISOString(),
  })
}

export function clearDeactivation(): void {
  removeSecureFile(deactivationPath())
}
