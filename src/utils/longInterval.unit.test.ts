import { afterEach, describe, expect, it, vi } from 'vitest'

import { startLongInterval } from './longInterval'

describe('startLongInterval', () => {
  afterEach(() => vi.useRealTimers())

  it('preserves intervals beyond Node timer limits', () => {
    vi.useFakeTimers({ now: 0 })
    const callback = vi.fn()
    const intervalMs = 2_147_483_647 + 1_000
    const interval = startLongInterval(callback, intervalMs)

    vi.advanceTimersByTime(2_147_483_647)
    expect(callback).not.toHaveBeenCalled()
    vi.advanceTimersByTime(1_000)
    expect(callback).toHaveBeenCalledOnce()

    interval.stop()
    vi.advanceTimersByTime(intervalMs)
    expect(callback).toHaveBeenCalledOnce()
  })
})
