/**
 * Multi-exchange ETH price aggregator.
 *
 * - Each exchange feed keeps a WebSocket open and updates an in-memory "latest
 *   quote" whenever a tick arrives (no queues, no buffering).
 * - A single 1Hz sampler reads across all feeds, drops anything older than
 *   staleMs (default 12s, matched to L1 block time), and stores one aggregated
 *   mid-price (median by default).
 * - A feed that goes quiet while its socket stays open is simply excluded from
 *   the aggregate until it publishes again. A CLOSED socket never publishes
 *   again (exchanges recycle connections routinely, e.g. Binance every 24h), so
 *   feeds reconnect after a fixed delay when the socket closes.
 *
 * NOTE: exchange WS message shapes reflect each exchange's public docs as of
 * early 2026. Verify against current docs before relying on this in production.
 */
import { EventEmitter } from 'node:events'

import WebSocket from 'ws'
import { z } from 'zod'

import { botWarn } from '../utils/log'

export interface Quote {
  exchange: string
  bid: number
  ask: number
  mid: number
  ts: number // ms epoch, when this quote was received locally
}

export interface AggregatedPrice {
  price: number
  method: 'median' | 'mean'
  ts: number
  contributingExchanges: string[]
  droppedExchanges: string[]
  /** Raw per-exchange mid prices that fed the aggregate (for observability). */
  readings: { exchange: string; mid: number }[]
}

const RECONNECT_DELAY_MS = 5_000
const RECONNECT_MAX_DELAY_MS = 120_000
export const CEX_MAX_PAYLOAD_BYTES = 64 * 1024
export const CEX_MAX_SPREAD_BPS = 100
export const CEX_MAX_DISPERSION_BPS = 200
const CEX_MIN_PRICE = 10
const CEX_MAX_PRICE = 10_000_000

const BINANCE_MESSAGE_SCHEMA = z.object({ b: z.string(), a: z.string() }).passthrough()
const COINBASE_MESSAGE_SCHEMA = z
  .object({
    type: z.string(),
    best_bid: z.string().optional(),
    best_ask: z.string().optional(),
  })
  .passthrough()
const KRAKEN_MESSAGE_SCHEMA = z
  .tuple([
    z.unknown(),
    z.object({ b: z.array(z.string()).min(1), a: z.array(z.string()).min(1) }),
    z.literal('ticker'),
  ])
  .rest(z.unknown())
const BOOK_LEVEL_SCHEMA = z.tuple([z.string()]).rest(z.unknown())
const OKX_MESSAGE_SCHEMA = z
  .object({
    data: z
      .array(
        z.object({
          bids: z.array(BOOK_LEVEL_SCHEMA).min(1),
          asks: z.array(BOOK_LEVEL_SCHEMA).min(1),
        }),
      )
      .min(1),
  })
  .passthrough()
const BYBIT_MESSAGE_SCHEMA = z
  .object({
    data: z.object({
      b: z.array(BOOK_LEVEL_SCHEMA).min(1),
      a: z.array(BOOK_LEVEL_SCHEMA).min(1),
    }),
  })
  .passthrough()

export abstract class ExchangeFeed extends EventEmitter {
  public readonly name: string
  protected ws: WebSocket | null = null
  private latest: Quote | null = null
  private stopped = false
  private reconnectTimer: NodeJS.Timeout | null = null
  private reconnectAttempts = 0
  private connectedAt = 0
  /** Log a feed's connection failure only once, so reconnects don't spam. */
  private errorLogged = false

  private readonly reconnectBaseMs: number
  private readonly random: () => number

  constructor(name: string, timing: { reconnectBaseMs?: number; random?: () => number } = {}) {
    super()
    this.name = name
    this.reconnectBaseMs = timing.reconnectBaseMs ?? RECONNECT_DELAY_MS
    this.random = timing.random ?? Math.random
  }

  abstract get url(): string
  abstract onOpen(ws: WebSocket): void
  abstract onMessage(raw: WebSocket.RawData): void

  connect(): void {
    if (
      this.stopped ||
      this.ws?.readyState === WebSocket.CONNECTING ||
      this.ws?.readyState === WebSocket.OPEN
    ) {
      return
    }
    const ws = new WebSocket(this.url, { maxPayload: CEX_MAX_PAYLOAD_BYTES })
    this.ws = ws
    ws.on('open', () => {
      this.connectedAt = Date.now()
      this.onOpen(ws)
    })
    // Surface a geo-block / handshake rejection (e.g. Binance HTTP 451) once, so
    // a permanently-starved feed is visible instead of silently "dropped".
    ws.on('unexpected-response', (_req, res) => {
      if (!this.errorLogged) {
        this.errorLogged = true
        botWarn(`[cex] ${this.name} feed rejected: HTTP ${res.statusCode}`)
      }
      res.resume()
      res.destroy()
      ws.terminate()
      this.scheduleReconnect()
    })
    ws.on('message', (data: WebSocket.RawData) => {
      try {
        this.onMessage(data)
      } catch {
        // Malformed message: ignore this tick, keep the connection alive.
        // Next valid tick overwrites `latest`.
      }
    })
    ws.on('close', () => {
      this.emit('disconnected', this.name)
      this.scheduleReconnect()
    })
    ws.on('error', (err) => {
      if (!this.errorLogged) {
        this.errorLogged = true
        botWarn(`[cex] ${this.name} feed error: ${err.message}`)
      }
      this.emit('error', { exchange: this.name, err })
      ws.terminate()
      this.scheduleReconnect()
    })
  }

  private scheduleReconnect(): void {
    if (this.stopped || this.reconnectTimer) return
    // Exponential backoff (5s, 10s, 20s, …) capped so repeated failures don't
    // hammer the exchange. Reset to 5s on a successful reconnect (see 'open').
    const baseDelay = Math.min(
      this.reconnectBaseMs * 2 ** this.reconnectAttempts,
      RECONNECT_MAX_DELAY_MS,
    )
    const delay = Math.round(baseDelay * (0.8 + this.random() * 0.4))
    this.reconnectAttempts += 1
    this.reconnectTimer = setTimeout(() => {
      this.reconnectTimer = null
      if (!this.stopped) this.connect()
    }, delay)
    this.reconnectTimer.unref?.()
  }

  protected setQuote(bid: number, ask: number): void {
    const mid = validateQuote(bid, ask)
    if (mid === null) return
    this.latest = { exchange: this.name, bid, ask, mid, ts: Date.now() }
    this.reconnectAttempts = 0
    this.errorLogged = false
  }

  getQuote(): Quote | null {
    return this.latest
  }

  recycleIfSilent(now: number, staleMs: number): void {
    if (this.latest && now - this.latest.ts <= staleMs * 2) return
    if (!this.latest && now - this.connectedAt <= staleMs * 2) return
    if (this.ws?.readyState === WebSocket.OPEN) this.ws.terminate()
  }

  close(): void {
    this.stopped = true
    if (this.reconnectTimer) {
      clearTimeout(this.reconnectTimer)
      this.reconnectTimer = null
    }
    this.ws?.close()
  }
}

class BinanceFeed extends ExchangeFeed {
  constructor() {
    super('binance')
  }
  get url(): string {
    // data-stream.binance.vision is Binance's market-data-only endpoint. It
    // serves the same streams as stream.binance.com but is NOT geo-blocked —
    // stream.binance.com returns HTTP 451 from restricted regions (e.g. the US),
    // which silently starved this feed (permanently "dropped" in the aggregate).
    return 'wss://data-stream.binance.vision/ws/ethusdt@bookTicker'
  }
  onOpen(): void {}
  onMessage(raw: WebSocket.RawData): void {
    const parsed = BINANCE_MESSAGE_SCHEMA.safeParse(JSON.parse(raw.toString()) as unknown)
    if (parsed.success) this.setQuote(Number(parsed.data.b), Number(parsed.data.a))
  }
}

class CoinbaseFeed extends ExchangeFeed {
  constructor() {
    super('coinbase')
  }
  get url(): string {
    return 'wss://ws-feed.exchange.coinbase.com'
  }
  onOpen(ws: WebSocket): void {
    ws.send(
      JSON.stringify({
        type: 'subscribe',
        channels: [{ name: 'ticker', product_ids: ['ETH-USD'] }],
      }),
    )
  }
  onMessage(raw: WebSocket.RawData): void {
    const parsed = COINBASE_MESSAGE_SCHEMA.safeParse(JSON.parse(raw.toString()) as unknown)
    if (
      parsed.success &&
      parsed.data.type === 'ticker' &&
      parsed.data.best_bid &&
      parsed.data.best_ask
    ) {
      this.setQuote(Number(parsed.data.best_bid), Number(parsed.data.best_ask))
    }
  }
}

class KrakenFeed extends ExchangeFeed {
  constructor() {
    super('kraken')
  }
  get url(): string {
    return 'wss://ws.kraken.com'
  }
  onOpen(ws: WebSocket): void {
    ws.send(
      JSON.stringify({
        event: 'subscribe',
        pair: ['ETH/USD'],
        subscription: { name: 'ticker' },
      }),
    )
  }
  onMessage(raw: WebSocket.RawData): void {
    const parsed = KRAKEN_MESSAGE_SCHEMA.safeParse(JSON.parse(raw.toString()) as unknown)
    if (parsed.success) {
      this.setQuote(Number(parsed.data[1].b[0]), Number(parsed.data[1].a[0]))
    }
  }
}

class OkxFeed extends ExchangeFeed {
  constructor() {
    super('okx')
  }
  get url(): string {
    return 'wss://ws.okx.com:8443/ws/v5/public'
  }
  onOpen(ws: WebSocket): void {
    ws.send(JSON.stringify({ op: 'subscribe', args: [{ channel: 'bbo-tbt', instId: 'ETH-USDT' }] }))
  }
  onMessage(raw: WebSocket.RawData): void {
    const parsed = OKX_MESSAGE_SCHEMA.safeParse(JSON.parse(raw.toString()) as unknown)
    if (parsed.success) {
      this.setQuote(Number(parsed.data.data[0].bids[0][0]), Number(parsed.data.data[0].asks[0][0]))
    }
  }
}

class BybitFeed extends ExchangeFeed {
  constructor() {
    super('bybit')
  }
  get url(): string {
    return 'wss://stream.bybit.com/v5/public/spot'
  }
  onOpen(ws: WebSocket): void {
    ws.send(JSON.stringify({ op: 'subscribe', args: ['orderbook.1.ETHUSDT'] }))
  }
  onMessage(raw: WebSocket.RawData): void {
    const parsed = BYBIT_MESSAGE_SCHEMA.safeParse(JSON.parse(raw.toString()) as unknown)
    if (parsed.success) {
      this.setQuote(Number(parsed.data.data.b[0][0]), Number(parsed.data.data.a[0][0]))
    }
  }
}

export interface AggregatorOptions {
  staleMs?: number // default 12_000, matched to L1 block time
  method?: 'median' | 'mean'
  sampleIntervalMs?: number // default 1000
  minFeeds?: number // minimum live feeds required to emit a price
}

/** Provider surface consumed by the CEX price source (testable without real WS). */
export interface LatestPriceProvider {
  start(): void
  stop(): void
  getLatest(): AggregatedPrice | null
}

export class PriceAggregator extends EventEmitter implements LatestPriceProvider {
  private readonly feeds: ExchangeFeed[]
  private readonly staleMs: number
  private readonly method: 'median' | 'mean'
  private readonly sampleIntervalMs: number
  private readonly minFeeds: number
  private timer: NodeJS.Timeout | null = null
  private latest: AggregatedPrice | null = null

  constructor(opts: AggregatorOptions = {}) {
    super()
    this.staleMs = opts.staleMs ?? 12_000
    this.method = opts.method ?? 'median'
    this.sampleIntervalMs = opts.sampleIntervalMs ?? 1_000
    this.minFeeds = opts.minFeeds ?? 3
    this.feeds = [
      new BinanceFeed(),
      new CoinbaseFeed(),
      new KrakenFeed(),
      new OkxFeed(),
      new BybitFeed(),
    ]
  }

  start(): void {
    if (this.timer) return
    for (const feed of this.feeds) {
      feed.on('error', (e) => this.emit('feedError', e))
      feed.connect()
    }
    this.timer = setInterval(() => this.sample(), this.sampleIntervalMs)
    // Do not keep the process alive solely for the sampler.
    this.timer.unref?.()
  }

  stop(): void {
    if (this.timer) {
      clearInterval(this.timer)
      this.timer = null
    }
    for (const feed of this.feeds) feed.close()
  }

  getLatest(): AggregatedPrice | null {
    return this.latest
  }

  private sample(): void {
    const now = Date.now()
    const live: Quote[] = []
    const dropped: string[] = []

    for (const feed of this.feeds) {
      const q = feed.getQuote()
      if (q && now - q.ts <= this.staleMs) live.push(q)
      else {
        dropped.push(feed.name)
        feed.recycleIfSilent(now, this.staleMs)
      }
    }

    const aggregate = buildAggregate(live, dropped, this.minFeeds, this.method, now)
    if (!aggregate) {
      this.latest = null
      this.emit('insufficientData', { live: live.length, needed: this.minFeeds })
      return
    }
    this.latest = aggregate
    this.emit('price', this.latest)
  }
}

function median(sorted: number[]): number {
  const n = sorted.length
  const mid = Math.floor(n / 2)
  return n % 2 === 0 ? (sorted[mid - 1] + sorted[mid]) / 2 : sorted[mid]
}

export function validateQuote(bid: number, ask: number): number | null {
  if (!Number.isFinite(bid) || !Number.isFinite(ask)) return null
  if (bid <= 0 || ask <= 0 || bid > ask) return null
  const mid = (bid + ask) / 2
  if (mid < CEX_MIN_PRICE || mid > CEX_MAX_PRICE) return null
  if (((ask - bid) * 10_000) / mid > CEX_MAX_SPREAD_BPS) return null
  return mid
}

export function rejectOutliers(quotes: Quote[], maxDispersionBps: number): Quote[] {
  if (quotes.length === 0) return []
  const center = median(quotes.map((quote) => quote.mid).sort((a, b) => a - b))
  return quotes.filter(
    (quote) => (Math.abs(quote.mid - center) * 10_000) / center <= maxDispersionBps,
  )
}

export function buildAggregate(
  live: Quote[],
  dropped: string[],
  minFeeds: number,
  method: 'median' | 'mean',
  now: number,
): AggregatedPrice | null {
  if (live.length < minFeeds) return null
  const filtered = rejectOutliers(live, CEX_MAX_DISPERSION_BPS)
  if (filtered.length < minFeeds) return null
  const rejected = live.filter((quote) => !filtered.includes(quote)).map((quote) => quote.exchange)
  const mids = filtered.map((quote) => quote.mid).sort((a, b) => a - b)
  return {
    price:
      method === 'median'
        ? median(mids)
        : mids.reduce((sum, value) => sum + value, 0) / mids.length,
    method,
    ts: now,
    contributingExchanges: filtered.map((quote) => quote.exchange),
    droppedExchanges: [...new Set([...dropped, ...rejected])],
    readings: filtered.map((quote) => ({ exchange: quote.exchange, mid: quote.mid })),
  }
}
