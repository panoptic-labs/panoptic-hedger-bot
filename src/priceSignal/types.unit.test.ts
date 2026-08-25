import { describe, expect, it, vi } from 'vitest'

import {
  type PriceSignal,
  type PriceSignalSource,
  PriceSignalUnavailableError,
  waitForPriceSignal,
} from './types'

const SIGNAL: PriceSignal = {
  tick: 123n,
  observedAtMs: 1,
  source: 'cex',
}

describe('waitForPriceSignal', () => {
  it('waits through transient warm-up and returns the first signal', async () => {
    let now = 0
    const getSignal = vi
      .fn<PriceSignalSource['getSignal']>()
      .mockRejectedValueOnce(new PriceSignalUnavailableError('warming up'))
      .mockRejectedValueOnce(new PriceSignalUnavailableError('warming up'))
      .mockResolvedValueOnce(SIGNAL)

    await expect(
      waitForPriceSignal(
        { kind: 'cex', getSignal },
        {
          timeoutMs: 1_000,
          retryIntervalMs: 100,
          nowMs: () => now,
          sleep: async (ms) => {
            now += ms
          },
        },
      ),
    ).resolves.toBe(SIGNAL)
    expect(getSignal).toHaveBeenCalledTimes(3)
    expect(now).toBe(200)
  })

  it('fails with a bounded timeout when the source never becomes ready', async () => {
    let now = 0
    const getSignal = vi
      .fn<PriceSignalSource['getSignal']>()
      .mockRejectedValue(new PriceSignalUnavailableError('warming up'))

    await expect(
      waitForPriceSignal(
        { kind: 'cex', getSignal },
        {
          timeoutMs: 250,
          retryIntervalMs: 100,
          nowMs: () => now,
          sleep: async (ms) => {
            now += ms
          },
        },
      ),
    ).rejects.toThrow('timed out after 250ms')
    expect(now).toBe(250)
  })

  it('does not retry hard source failures', async () => {
    const getSignal = vi
      .fn<PriceSignalSource['getSignal']>()
      .mockRejectedValue(new Error('bad pair'))

    await expect(waitForPriceSignal({ kind: 'cex', getSignal })).rejects.toThrow('bad pair')
    expect(getSignal).toHaveBeenCalledOnce()
  })
})
