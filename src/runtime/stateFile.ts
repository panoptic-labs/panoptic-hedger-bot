import { readFileSync, unlinkSync, writeFileSync } from 'node:fs'
import path from 'node:path'
import { fileURLToPath } from 'node:url'

/**
 * A tiny on-disk heartbeat the running bot writes each cycle, so `pnpm status`
 * (a separate process) can report running-state and last poll/hedge without the
 * bot exposing a socket. Best-effort: failures to read/write never affect the
 * hedge loop. Contains no secrets — but is gitignored/leak-checked anyway.
 */

export interface RuntimeState {
  pid: number
  version: string
  startedAt: string
  /** Effective mode the loop is running in (activation-aware). */
  dryRun: boolean
  chainId: number
  safe: `0x${string}`
  pool: `0x${string}`
  lastPollAt?: string
  lastPollTrigger?: string
  lastHedgeAt?: string
  lastHedgeAction?: string
  lastHedgeTx?: string
}

export function runtimeStatePath(): string {
  return process.env.HEDGER_STATE_PATH ?? path.resolve(process.cwd(), '.hedger-runtime.json')
}

/** The bot's package version (for status + activation records). */
export function botVersion(): string {
  try {
    const pkgUrl = new URL('../../package.json', import.meta.url)
    const pkg = JSON.parse(readFileSync(fileURLToPath(pkgUrl), 'utf8')) as { version?: string }
    return pkg.version ?? '0.0.0'
  } catch {
    return '0.0.0'
  }
}

export function readRuntimeState(): RuntimeState | null {
  try {
    return JSON.parse(readFileSync(runtimeStatePath(), 'utf8')) as RuntimeState
  } catch {
    return null
  }
}

export function writeRuntimeState(state: RuntimeState): void {
  try {
    writeFileSync(runtimeStatePath(), `${JSON.stringify(state, null, 2)}\n`, { mode: 0o600 })
  } catch {
    // Best-effort heartbeat — never let a disk error stop hedging.
  }
}

/** Merge a partial update into the current state (no-op if none exists). */
export function patchRuntimeState(patch: Partial<RuntimeState>): void {
  const current = readRuntimeState()
  if (!current) return
  writeRuntimeState({ ...current, ...patch })
}

export function clearRuntimeState(): void {
  try {
    unlinkSync(runtimeStatePath())
  } catch {
    // already gone
  }
}

/** True if a process with this pid is alive (EPERM still means it exists). */
export function isProcessAlive(pid: number): boolean {
  try {
    process.kill(pid, 0)
    return true
  } catch (err) {
    return (err as NodeJS.ErrnoException).code === 'EPERM'
  }
}

export interface RunningStatus {
  /** The bot process is alive AND has polled recently. */
  running: boolean
  /** The pid is alive but the last poll is older than the freshness window. */
  stalled: boolean
  reason: string
}

/**
 * Decide whether the bot is running from the heartbeat: the pid must be alive
 * and the last poll must be fresher than `2 × pollIntervalMs` (a wide margin so
 * a single slow cycle doesn't read as dead).
 */
export function computeRunning(
  state: RuntimeState | null,
  pollIntervalMs: number,
  nowMs: number = Date.now(),
): RunningStatus {
  if (!state) return { running: false, stalled: false, reason: 'no runtime state file' }
  if (!isProcessAlive(state.pid)) {
    return { running: false, stalled: false, reason: `pid ${state.pid} not alive` }
  }
  if (!state.lastPollAt) {
    return { running: true, stalled: false, reason: 'started, first poll pending' }
  }
  const ageMs = nowMs - Date.parse(state.lastPollAt)
  const freshWindow = Math.max(pollIntervalMs * 2, 30_000)
  if (ageMs > freshWindow) {
    return {
      running: false,
      stalled: true,
      reason: `pid ${state.pid} alive but last poll ${Math.round(ageMs / 1000)}s ago (> ${Math.round(
        freshWindow / 1000,
      )}s)`,
    }
  }
  return { running: true, stalled: false, reason: `last poll ${Math.round(ageMs / 1000)}s ago` }
}
