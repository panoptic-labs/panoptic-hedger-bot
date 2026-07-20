import { computeRunning, readRuntimeState } from '../src/runtime/stateFile'

const state = readRuntimeState()
const running = computeRunning(state, state?.pollIntervalMs ?? 60_000)
const healthy = Boolean(
  state &&
  running.running &&
  state.ready &&
  state.lifecycle === 'ready' &&
  (state.notificationConsecutiveFailures ?? 0) < 3 &&
  (state.consecutiveSignalFailures ?? 0) < 3,
)

console.log(
  JSON.stringify({
    healthy,
    running: running.running,
    ready: state?.ready ?? false,
    lifecycle: state?.lifecycle ?? 'missing',
    reason: running.reason,
    signalFailures: state?.consecutiveSignalFailures ?? 0,
    notificationFailures: state?.notificationConsecutiveFailures ?? 0,
  }),
)
if (!healthy) process.exitCode = 1
