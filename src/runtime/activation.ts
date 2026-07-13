import { readFileSync, unlinkSync, writeFileSync } from 'node:fs'
import path from 'node:path'

import type { HedgerBotConfig } from '../config'
import { botVersion } from './stateFile'

/**
 * Live-trading activation marker. `pnpm start` runs live ONLY when a valid
 * marker exists; otherwise it forces dry-run regardless of DRY_RUN. `pnpm
 * activate` writes the marker after a passing preflight, making "go live" a
 * deliberate, auditable step separate from the DRY_RUN toggle.
 *
 * The marker is pinned to the Safe/pool/chain it was created for, so pointing
 * the bot at a different deployment (a new `.env`) invalidates it and the bot
 * falls back to dry-run until re-activated.
 */

export interface ActivationMarker {
  activatedAt: string
  version: string
  chainId: number
  safe: `0x${string}`
  pool: `0x${string}`
  /** Whether preflight (`doctor`) passed at activation time — recorded for audit. */
  doctorPassed: boolean
}

export function activationPath(): string {
  return process.env.HEDGER_ACTIVATED_PATH ?? path.resolve(process.cwd(), '.hedger-activated.json')
}

export function readActivation(): ActivationMarker | null {
  try {
    return JSON.parse(readFileSync(activationPath(), 'utf8')) as ActivationMarker
  } catch {
    return null
  }
}

export function writeActivation(marker: ActivationMarker): void {
  writeFileSync(activationPath(), `${JSON.stringify(marker, null, 2)}\n`, { mode: 0o600 })
}

export function clearActivation(): void {
  try {
    unlinkSync(activationPath())
  } catch {
    // already gone
  }
}

/** Build a marker for the current config (call after a passing preflight). */
export function buildActivationMarker(
  config: HedgerBotConfig,
  doctorPassed: boolean,
  activatedAt: string,
): ActivationMarker {
  return {
    activatedAt,
    version: botVersion(),
    chainId: config.CHAIN_ID,
    safe: config.SAFE_ADDRESS,
    pool: config.POOL_ADDRESS,
    doctorPassed,
  }
}

/**
 * True when a marker exists AND matches the current Safe/pool/chain. A mismatch
 * (re-onboarded to a different deployment) is treated as NOT activated.
 */
export function isActivated(config: HedgerBotConfig): boolean {
  const m = readActivation()
  if (!m) return false
  return (
    m.chainId === config.CHAIN_ID &&
    m.safe.toLowerCase() === config.SAFE_ADDRESS.toLowerCase() &&
    m.pool.toLowerCase() === config.POOL_ADDRESS.toLowerCase()
  )
}
