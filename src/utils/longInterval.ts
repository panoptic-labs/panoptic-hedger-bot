const MAX_TIMER_DELAY_MS = 2_147_483_647

export interface LongInterval {
  stop(): void
}

/**
 * Run a recurring callback without Node's 32-bit timer-delay ceiling turning
 * intervals longer than ~24.9 days into rapid-fire one-millisecond timers.
 */
export function startLongInterval(callback: () => void, intervalMs: number): LongInterval {
  let stopped = false
  let timer: ReturnType<typeof setTimeout> | undefined
  let deadline = BigInt(Date.now()) + BigInt(intervalMs)

  const schedule = () => {
    if (stopped) return
    const remaining = deadline - BigInt(Date.now())
    const delay = Number(
      remaining <= 0n
        ? 0n
        : remaining > BigInt(MAX_TIMER_DELAY_MS)
          ? MAX_TIMER_DELAY_MS
          : remaining,
    )
    timer = setTimeout(onTimer, delay)
  }

  const onTimer = () => {
    if (stopped) return
    if (BigInt(Date.now()) < deadline) {
      schedule()
      return
    }
    callback()
    deadline = BigInt(Date.now()) + BigInt(intervalMs)
    schedule()
  }

  schedule()
  return {
    stop() {
      stopped = true
      if (timer) clearTimeout(timer)
    },
  }
}
