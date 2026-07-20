import { readFileSync } from 'node:fs'
import { fileURLToPath } from 'node:url'

import { z } from 'zod'

import { runtimeDataPath } from './paths'
import { readSecureJson, removeSecureFile, writeSecureJson } from './secureFile'

const iso = z.string().datetime()
const runtimeStateSchema = z
  .object({
    schemaVersion: z.literal(2),
    instanceId: z.string().uuid(),
    pid: z.number().int().positive(),
    signer: z.string().regex(/^0x[0-9a-fA-F]{40}$/),
    version: z.string().min(1).max(128),
    startedAt: iso,
    updatedAt: iso,
    dryRun: z.boolean(),
    chainId: z.number().int().positive(),
    safe: z.string().regex(/^0x[0-9a-fA-F]{40}$/),
    pool: z.string().regex(/^0x[0-9a-fA-F]{40}$/),
    pollIntervalMs: z.number().int().min(5_000).max(300_000),
    lifecycle: z.enum(['starting', 'ready', 'degraded', 'failed']),
    ready: z.boolean(),
    initAttempts: z.number().int().nonnegative(),
    lastInitErrorCode: z.string().min(1).max(128).optional(),
    lastPollAt: iso.optional(),
    lastPollCompletedAt: iso.optional(),
    lastPollTrigger: z.string().min(1).max(64).optional(),
    lastCycleOutcome: z.enum(['complete', 'signal-unavailable', 'error']).optional(),
    consecutiveSignalFailures: z.number().int().nonnegative().optional(),
    lastHedgeAt: iso.optional(),
    lastHedgeAction: z.string().min(1).max(64).optional(),
    lastHedgeTx: z
      .string()
      .regex(/^0x[0-9a-fA-F]+$/)
      .optional(),
    notificationLastSuccessAt: iso.optional(),
    notificationLastFailureAt: iso.optional(),
    notificationConsecutiveFailures: z.number().int().nonnegative().optional(),
  })
  .strict()

export type RuntimeState = z.infer<typeof runtimeStateSchema>
const MAX_RUNTIME_BYTES = 32 * 1024

export function runtimeStatePath(): string {
  return process.env.HEDGER_STATE_PATH ?? runtimeDataPath('.hedger-runtime.json')
}

export function botVersion(): string {
  try {
    const pkgUrl = new URL('../../package.json', import.meta.url)
    const parsed = JSON.parse(readFileSync(fileURLToPath(pkgUrl), 'utf8')) as unknown
    const pkg = z
      .object({ version: z.string().min(1).max(128) })
      .passthrough()
      .parse(parsed)
    const buildId = process.env.HEDGER_BUILD_ID
    if (!buildId) return pkg.version
    return `${pkg.version}+${z
      .string()
      .regex(/^[0-9a-f]{40}$/)
      .parse(buildId)}`
  } catch {
    return '0.0.0'
  }
}

export function readRuntimeState(): RuntimeState | null {
  return readSecureJson(runtimeStatePath(), runtimeStateSchema, {
    maxBytes: MAX_RUNTIME_BYTES,
    invalid: 'null',
  })
}

export function writeRuntimeState(state: RuntimeState): void {
  writeSecureJson(runtimeStatePath(), runtimeStateSchema, state)
}

export function patchRuntimeState(
  instanceId: string,
  patch: Partial<Omit<RuntimeState, 'schemaVersion' | 'instanceId' | 'pid'>>,
): void {
  const current = readRuntimeState()
  if (!current) throw new Error('runtime heartbeat is missing or invalid')
  if (current.instanceId !== instanceId || current.pid !== process.pid) {
    throw new Error('runtime heartbeat belongs to another process instance')
  }
  writeRuntimeState({ ...current, ...patch, updatedAt: new Date().toISOString() })
}

export function clearRuntimeState(instanceId?: string): void {
  try {
    if (instanceId) {
      const current = readRuntimeState()
      if (!current || current.instanceId !== instanceId || current.pid !== process.pid) return
    }
    removeSecureFile(runtimeStatePath())
  } catch (error) {
    if (!error || typeof error !== 'object' || Reflect.get(error, 'code') !== 'ENOENT') throw error
  }
}

export function isProcessAlive(pid: number): boolean {
  try {
    process.kill(pid, 0)
    return true
  } catch (error) {
    return Boolean(error && typeof error === 'object' && Reflect.get(error, 'code') === 'EPERM')
  }
}

export interface RunningStatus {
  running: boolean
  stalled: boolean
  reason: string
}

export function computeRunning(
  state: RuntimeState | null,
  pollIntervalMs: number,
  nowMs: number = Date.now(),
): RunningStatus {
  if (!state) return { running: false, stalled: false, reason: 'no trusted runtime heartbeat' }
  if (!isProcessAlive(state.pid)) {
    return { running: false, stalled: false, reason: `pid ${state.pid} not alive` }
  }
  const freshWindow = Math.max(pollIntervalMs * 2, 30_000)
  if (!state.lastPollAt) {
    const startupAge = nowMs - Date.parse(state.startedAt)
    if (startupAge > freshWindow) {
      return { running: false, stalled: true, reason: 'initialization/first poll stalled' }
    }
    return { running: true, stalled: false, reason: 'starting; first poll pending' }
  }
  const ageMs = nowMs - Date.parse(state.lastPollAt)
  if (ageMs > freshWindow) {
    return {
      running: false,
      stalled: true,
      reason: `pid ${state.pid} alive but last poll ${Math.round(ageMs / 1000)}s ago`,
    }
  }
  return { running: true, stalled: false, reason: `last poll ${Math.round(ageMs / 1000)}s ago` }
}
