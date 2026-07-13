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

abstract class ExchangeFeed extends EventEmitter {
  public readonly name: string
  protected ws: WebSocket | null = null
  private latest: Quote | null = null
  private stopped = false
  private reconnectTimer: NodeJS.Timeout | null = null
  private reconnectAttempts = 0
  /** Log a feed's connection failure only once, so reconnects don't spam. */
  private errorLogged = false

  constructor(name: string) {
    super()
    this.name = name
  }

  abstract get url(): string
  abstract onOpen(ws: WebSocket): void
  abstract onMessage(raw: WebSocket.RawData): void

  connect(): void {
    const ws = new WebSocket(this.url)
    this.ws = ws
    ws.on('open', () => {
      this.reconnectAttempts = 0 // reset backoff on a successful connect
      this.errorLogged = false
      this.onOpen(ws)
    })
    // Surface a geo-block / handshake rejection (e.g. Binance HTTP 451) once, so
    // a permanently-starved feed is visible instead of silently "dropped".
    ws.on('unexpected-response', (_req, res) => {
      if (!this.errorLogged) {
        this.errorLogged = true
        botWarn(`[cex] ${this.name} feed rejected: HTTP ${res.statusCode} (${this.url})`)
      }
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
    })
  }

  private scheduleReconnect(): void {
    if (this.stopped || this.reconnectTimer) return
    // Exponential backoff (5s, 10s, 20s, …) capped so repeated failures don't
    // hammer the exchange. Reset to 5s on a successful reconnect (see 'open').
    const delay = Math.min(RECONNECT_DELAY_MS * 2 ** this.reconnectAttempts, RECONNECT_MAX_DELAY_MS)
    this.reconnectAttempts += 1
    this.reconnectTimer = setTimeout(() => {
      this.reconnectTimer = null
      if (!this.stopped) this.connect()
    }, delay)
    this.reconnectTimer.unref?.()
  }

  protected setQuote(bid: number, ask: number): void {
    const mid = (bid + ask) / 2
    this.latest = { exchange: this.name, bid, ask, mid, ts: Date.now() }
  }

  getQuote(): Quote | null {
    return this.latest
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
    const msg = JSON.parse(raw.toString())
    if (msg.b && msg.a) this.setQuote(parseFloat(msg.b), parseFloat(msg.a))
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
    const msg = JSON.parse(raw.toString())
    if (msg.type === 'ticker' && msg.best_bid && msg.best_ask) {
      this.setQuote(parseFloat(msg.best_bid), parseFloat(msg.best_ask))
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
    const msg = JSON.parse(raw.toString())
    if (Array.isArray(msg) && msg[2] === 'ticker') {
      this.setQuote(parseFloat(msg[1].b[0]), parseFloat(msg[1].a[0]))
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
    const msg = JSON.parse(raw.toString())
    const book = msg.data?.[0]
    if (book?.bids?.[0] && book?.asks?.[0]) {
      this.setQuote(parseFloat(book.bids[0][0]), parseFloat(book.asks[0][0]))
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
    const data = JSON.parse(raw.toString()).data
    if (data?.b?.[0] && data?.a?.[0]) {
      this.setQuote(parseFloat(data.b[0][0]), parseFloat(data.a[0][0]))
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
    this.minFeeds = opts.minFeeds ?? 1
    this.feeds = [
      new BinanceFeed(),
      new CoinbaseFeed(),
      new KrakenFeed(),
      new OkxFeed(),
      new BybitFeed(),
    ]
  }

  start(): void {
    for (const feed of this.feeds) {
      feed.on('error', (e) => this.emit('feedError', e))
      feed.connect()
    }
    this.timer = setInterval(() => this.sample(), this.sampleIntervalMs)
    // Do not keep the process alive solely for the sampler.
    this.timer.unref?.()
  }

  stop(): void {
    if (this.timer) clearInterval(this.timer)
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
      else dropped.push(feed.name)
    }

    if (live.length < this.minFeeds) {
      this.emit('insufficientData', { live: live.length, needed: this.minFeeds })
      return
    }

    const mids = live.map((q) => q.mid).sort((a, b) => a - b)
    const price =
      this.method === 'median' ? median(mids) : mids.reduce((s, v) => s + v, 0) / mids.length

    this.latest = {
      price,
      method: this.method,
      ts: now,
      contributingExchanges: live.map((q) => q.exchange),
      droppedExchanges: dropped,
      readings: live.map((q) => ({ exchange: q.exchange, mid: q.mid })),
    }
    this.emit('price', this.latest)
  }
}

function median(sorted: number[]): number {
  const n = sorted.length
  const mid = Math.floor(n / 2)
  return n % 2 === 0 ? (sorted[mid - 1] + sorted[mid]) / 2 : sorted[mid]
}
