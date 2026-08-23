export interface TimedHedgeCadence {
  enabled: boolean
  due: boolean
  lastDeltaHedgeAt: string | null
  nextDueAt: string | null
}

/** Pure timed-hedge clock. Missing or invalid history is deliberately due now. */
export function timedHedgeCadence(
  intervalMs: number | undefined,
  lastDeltaHedgeAt: string | undefined,
  nowMs: number = Date.now(),
): TimedHedgeCadence {
  if (intervalMs === undefined || !Number.isFinite(intervalMs) || intervalMs <= 0) {
    return { enabled: false, due: false, lastDeltaHedgeAt: null, nextDueAt: null }
  }
  const lastMs = lastDeltaHedgeAt === undefined ? Number.NaN : Date.parse(lastDeltaHedgeAt)
  if (!Number.isFinite(lastMs)) {
    return { enabled: true, due: true, lastDeltaHedgeAt: null, nextDueAt: null }
  }
  const nextMs = lastMs + intervalMs
  return {
    enabled: true,
    due: nowMs >= nextMs,
    lastDeltaHedgeAt: new Date(lastMs).toISOString(),
    nextDueAt: new Date(nextMs).toISOString(),
  }
}
