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
