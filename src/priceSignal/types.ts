import type { PriceSignalSourceKind } from '../config'

/**
 * A price observation the delta math is evaluated at. `tick` is a Uniswap-style
 * tick so it can be fed directly into the SDK greeks/hedge functions.
 */
export interface PriceSignal {
  /** Uniswap-style tick to evaluate deltas at. */
  tick: bigint
  /** Full-precision price when the source can provide it (pool sources). */
  sqrtPriceX96?: bigint
  /**
   * When the observation is valid "as of", in unix ms. For on-chain sources
   * this is the block timestamp; for off-chain feeds it is the fetch time.
   * The main loop gates on this for staleness.
   */
  observedAtMs: number
  /** Exact chain block for on-chain observations. */
  blockNumber?: bigint
  source: PriceSignalSourceKind
  /** Human price (token1 per token0 units, or USD for cex) when derivable — for logs. */
  price?: number
  /**
   * Optional human-readable diagnostic for the log: the raw readings and how
   * they were combined (e.g. the per-exchange mids + the medianized price).
   */
  detail?: string
}

/**
 * Thrown when a price source has no fresh reading YET — e.g. the cex aggregator
 * is still warming up its WebSocket feeds at startup, or the latest aggregate is
 * momentarily stale. This is a transient, expected condition: the caller should
 * skip the cycle and retry, NOT treat it as a hard error.
 */
export class PriceSignalUnavailableError extends Error {
  constructor(message: string) {
    super(message)
    this.name = 'PriceSignalUnavailableError'
  }
}

/** A pluggable source of hedging price signals. Implementations must throw on failure/staleness. */
export interface PriceSignalSource {
  readonly kind: PriceSignalSourceKind
  getSignal(): Promise<PriceSignal>
  /** Release any background resources (e.g. CEX WebSocket feeds). Optional. */
  stop?(): void
}

export interface WaitForPriceSignalOptions {
  /** Maximum time one-shot commands wait for a transient source to become ready. */
  timeoutMs?: number
  retryIntervalMs?: number
  /** Test seams; production callers should use the defaults. */
  nowMs?: () => number
  sleep?: (ms: number) => Promise<void>
}

export const PRICE_SIGNAL_WARMUP_TIMEOUT_MS = 15_000

/**
 * Wait for a transiently unavailable source to produce its first fresh signal.
 *
 * The live hedger remains non-blocking and skips unavailable cycles. One-shot
 * commands such as activation and inspection need different semantics: their
 * freshly-created CEX WebSockets must be allowed to connect and reach quorum
 * before the command decides that inspection failed.
 */
export async function waitForPriceSignal(
  source: PriceSignalSource,
  options: WaitForPriceSignalOptions = {},
): Promise<PriceSignal> {
  const timeoutMs = options.timeoutMs ?? PRICE_SIGNAL_WARMUP_TIMEOUT_MS
  const retryIntervalMs = options.retryIntervalMs ?? 250
  const nowMs = options.nowMs ?? Date.now
  const sleep =
    options.sleep ?? ((ms: number) => new Promise<void>((resolve) => setTimeout(resolve, ms)))
  const deadline = nowMs() + timeoutMs

  for (;;) {
    try {
      return await source.getSignal()
    } catch (error) {
      if (!(error instanceof PriceSignalUnavailableError)) throw error
      const remainingMs = deadline - nowMs()
      if (remainingMs <= 0) {
        throw new PriceSignalUnavailableError(
          `${error.message}; timed out after ${timeoutMs}ms waiting for a fresh price signal`,
        )
      }
      await sleep(Math.min(retryIntervalMs, remainingMs))
    }
  }
}
