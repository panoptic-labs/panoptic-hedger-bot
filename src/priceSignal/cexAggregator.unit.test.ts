import { type Server, createServer } from 'node:http'

import { afterEach, beforeAll, describe, expect, it } from 'vitest'
import WebSocket, { WebSocketServer } from 'ws'

import { server as requestMockServer } from '../../setup-tests'
import {
  BitstampFeed,
  buildAggregate,
  CEX_MAX_PAYLOAD_BYTES,
  ExchangeFeed,
  GeminiFeed,
  KrakenFeed,
  rejectOutliers,
  validateQuote,
} from './cexAggregator'

describe('CEX quote policy', () => {
  it.each([
    [Number.NaN, 3_001],
    [Number.POSITIVE_INFINITY, 3_001],
    [0, 3_001],
    [3_002, 3_001],
    [3_000, 3_100],
    [1, 2],
  ])('rejects malformed or unsafe bid/ask %s/%s', (bid, ask) => {
    expect(validateQuote(bid, ask)).toBeNull()
  })

  it('accepts a finite positive narrow market', () => {
    expect(validateQuote(3_000, 3_001)).toBe(3_000.5)
  })

  it('parses Kraken v2 tickers and ignores non-ticker frames', () => {
    const feed = new KrakenFeed()
    expect(() =>
      feed.onMessage(Buffer.from(JSON.stringify({ method: 'subscribe', success: true }))),
    ).not.toThrow()
    expect(feed.getQuote()).toBeNull()

    feed.onMessage(
      Buffer.from(
        JSON.stringify({
          channel: 'ticker',
          type: 'snapshot',
          data: [{ symbol: 'ETH/USD', bid: 3_412.25, ask: 3_412.75 }],
        }),
      ),
    )

    expect(feed.getQuote()).toMatchObject({
      exchange: 'kraken',
      bid: 3_412.25,
      ask: 3_412.75,
      mid: 3_412.5,
    })
  })

  it('parses Bitstamp order-book updates and ignores subscription acknowledgements', () => {
    const feed = new BitstampFeed()
    feed.onMessage(
      Buffer.from(
        JSON.stringify({
          event: 'bts:subscription_succeeded',
          channel: 'order_book_ethusd',
          data: {},
        }),
      ),
    )
    expect(feed.getQuote()).toBeNull()

    feed.onMessage(
      Buffer.from(
        JSON.stringify({
          event: 'data',
          channel: 'order_book_ethusd',
          data: {
            bids: [
              ['3412.25', '1.5'],
              ['3412.00', '2.0'],
            ],
            asks: [
              ['3412.75', '1.25'],
              ['3413.00', '3.0'],
            ],
          },
        }),
      ),
    )

    expect(feed.getQuote()).toMatchObject({
      exchange: 'bitstamp',
      bid: 3_412.25,
      ask: 3_412.75,
      mid: 3_412.5,
    })
  })

  it('retains Gemini top-of-book state across one-sided updates', () => {
    const feed = new GeminiFeed()
    feed.onMessage(
      Buffer.from(
        JSON.stringify({
          type: 'update',
          events: [
            { type: 'change', side: 'ask', price: '3412.75', remaining: '1.5' },
            { type: 'change', side: 'bid', price: '3412.25', remaining: '2.0' },
          ],
        }),
      ),
    )
    expect(feed.getQuote()).toMatchObject({
      exchange: 'gemini',
      bid: 3_412.25,
      ask: 3_412.75,
      mid: 3_412.5,
    })

    feed.onMessage(
      Buffer.from(
        JSON.stringify({
          type: 'update',
          events: [{ type: 'change', side: 'bid', price: '3412.50', remaining: '1.0' }],
        }),
      ),
    )
    expect(feed.getQuote()).toMatchObject({ bid: 3_412.5, ask: 3_412.75, mid: 3_412.625 })
  })

  it('removes a compromised feed before medianization', () => {
    const now = Date.now()
    const quotes = [3_000, 3_001, 3_002, 9_000].map((mid, index) => ({
      exchange: `feed-${index}`,
      bid: mid - 0.5,
      ask: mid + 0.5,
      mid,
      ts: now,
    }))
    expect(rejectOutliers(quotes, 200).map((quote) => quote.mid)).toEqual([3_000, 3_001, 3_002])
  })

  it('requires an uncompromised three-feed quorum and recovers when it returns', () => {
    const now = Date.now()
    const quotes = [3_000, 3_001, 3_002].map((mid, index) => ({
      exchange: `feed-${index}`,
      bid: mid - 0.5,
      ask: mid + 0.5,
      mid,
      ts: now,
    }))
    expect(buildAggregate(quotes.slice(0, 1), [], 3, 'median', now)).toBeNull()
    expect(buildAggregate(quotes, [], 3, 'median', now)?.contributingExchanges).toHaveLength(3)
  })

  it('reconnects after 429, 451, and 5xx handshake responses', async ({ skip }) => {
    requestMockServer.close()
    const statuses = [429, 451, 503]
    let requests = 0
    let resolveAll: (() => void) | undefined
    const allResponses = new Promise<void>((resolve) => {
      resolveAll = resolve
    })
    const server = createServer((_request, response) => {
      const status = statuses[Math.min(requests, statuses.length - 1)]
      requests += 1
      response.writeHead(status)
      response.end()
      if (requests >= statuses.length) resolveAll?.()
    })
    try {
      await new Promise<void>((resolve, reject) => {
        server.once('error', reject)
        server.listen(0, '127.0.0.1', resolve)
      })
    } catch (error) {
      if ((error as NodeJS.ErrnoException).code === 'EPERM') {
        skip()
        return
      }
      throw error
    }
    const address = server.address()
    if (address === null || typeof address === 'string') throw new Error('missing test server port')
    // Capture the port here: TS drops the narrowing above inside the nested
    // class/closure below (captured vars aren't narrowed across function scopes).
    const { port } = address

    class RejectedFeed extends ExchangeFeed {
      constructor() {
        super('rejected', { reconnectBaseMs: 5, random: () => 0.5 })
      }
      get url() {
        return `ws://127.0.0.1:${port}`
      }
      onOpen(): void {}
      onMessage(_raw: WebSocket.RawData): void {}
    }

    const feed = new RejectedFeed()
    feed.on('error', () => undefined)
    feed.connect()
    await Promise.race([
      allResponses,
      new Promise<never>((_resolve, reject) =>
        setTimeout(() => reject(new Error('feed did not reconnect')), 2_000),
      ),
    ])
    feed.close()
    await new Promise<void>((resolve) => server.close(() => resolve()))
    expect(requests).toBe(3)
  })
})

describe('CEX WebSocket resource bounds', () => {
  const servers: WebSocketServer[] = []
  const httpServers: Server[] = []
  const clients: WebSocket[] = []

  // The global harness rejects all unmocked HTTP. This test intentionally uses
  // only an isolated loopback WebSocket, so stop this worker's interceptor.
  beforeAll(() => requestMockServer.close())

  afterEach(async () => {
    for (const client of clients) client.terminate()
    await Promise.all(
      servers.map(
        (server) =>
          new Promise<void>((resolve) => {
            server.close(() => resolve())
          }),
      ),
    )
    await Promise.all(
      httpServers.map(
        (server) =>
          new Promise<void>((resolve) => {
            server.close(() => resolve())
          }),
      ),
    )
  })

  it('subscribes to Kraken WebSocket API v2', async ({ skip }) => {
    const httpServer = createServer()
    httpServers.push(httpServer)
    try {
      await new Promise<void>((resolve, reject) => {
        httpServer.once('error', reject)
        httpServer.listen(0, '127.0.0.1', resolve)
      })
    } catch (error) {
      if ((error as NodeJS.ErrnoException).code === 'EPERM') {
        skip()
        return
      }
      throw error
    }
    const server = new WebSocketServer({ server: httpServer })
    servers.push(server)
    const address = httpServer.address()
    if (address === null || typeof address === 'string') throw new Error('missing test server port')
    const { port } = address

    class LocalKrakenFeed extends KrakenFeed {
      get url(): string {
        return `ws://127.0.0.1:${port}`
      }
    }

    const subscription = new Promise<unknown>((resolve) => {
      server.on('connection', (socket) => {
        socket.once('message', (raw) => {
          resolve(JSON.parse(raw.toString()) as unknown)
          socket.send(
            JSON.stringify({
              channel: 'ticker',
              type: 'snapshot',
              data: [{ symbol: 'ETH/USD', bid: 3_412.25, ask: 3_412.75 }],
            }),
          )
        })
      })
    })
    const feed = new LocalKrakenFeed()
    feed.connect()
    await expect(subscription).resolves.toEqual({
      method: 'subscribe',
      params: { channel: 'ticker', symbol: ['ETH/USD'] },
    })
    await expect
      .poll(() => feed.getQuote())
      .toMatchObject({ exchange: 'kraken', bid: 3_412.25, ask: 3_412.75, mid: 3_412.5 })
    feed.close()
  })

  it('subscribes to and receives Bitstamp order-book updates', async ({ skip }) => {
    const httpServer = createServer()
    httpServers.push(httpServer)
    try {
      await new Promise<void>((resolve, reject) => {
        httpServer.once('error', reject)
        httpServer.listen(0, '127.0.0.1', resolve)
      })
    } catch (error) {
      if ((error as NodeJS.ErrnoException).code === 'EPERM') {
        skip()
        return
      }
      throw error
    }
    const server = new WebSocketServer({ server: httpServer })
    servers.push(server)
    const address = httpServer.address()
    if (address === null || typeof address === 'string') throw new Error('missing test server port')
    const { port } = address

    class LocalBitstampFeed extends BitstampFeed {
      get url(): string {
        return `ws://127.0.0.1:${port}`
      }
    }

    const subscription = new Promise<unknown>((resolve) => {
      server.on('connection', (socket) => {
        socket.once('message', (raw) => {
          resolve(JSON.parse(raw.toString()) as unknown)
          socket.send(
            JSON.stringify({
              event: 'data',
              channel: 'order_book_ethusd',
              data: { bids: [['3412.25', '1.5']], asks: [['3412.75', '1.25']] },
            }),
          )
        })
      })
    })
    const feed = new LocalBitstampFeed()
    feed.connect()
    await expect(subscription).resolves.toEqual({
      event: 'bts:subscribe',
      data: { channel: 'order_book_ethusd' },
    })
    await expect
      .poll(() => feed.getQuote())
      .toMatchObject({ exchange: 'bitstamp', bid: 3_412.25, ask: 3_412.75, mid: 3_412.5 })
    feed.close()
  })

  it('receives Gemini top-of-book updates without a subscription message', async ({ skip }) => {
    const httpServer = createServer()
    httpServers.push(httpServer)
    try {
      await new Promise<void>((resolve, reject) => {
        httpServer.once('error', reject)
        httpServer.listen(0, '127.0.0.1', resolve)
      })
    } catch (error) {
      if ((error as NodeJS.ErrnoException).code === 'EPERM') {
        skip()
        return
      }
      throw error
    }
    const server = new WebSocketServer({ server: httpServer })
    servers.push(server)
    const address = httpServer.address()
    if (address === null || typeof address === 'string') throw new Error('missing test server port')
    const { port } = address

    class LocalGeminiFeed extends GeminiFeed {
      get url(): string {
        return `ws://127.0.0.1:${port}`
      }
    }

    server.on('connection', (socket) => {
      socket.send(
        JSON.stringify({
          type: 'update',
          events: [
            { type: 'change', side: 'ask', price: '3412.75', remaining: '1.5' },
            { type: 'change', side: 'bid', price: '3412.25', remaining: '2.0' },
          ],
        }),
      )
    })
    const feed = new LocalGeminiFeed()
    feed.connect()
    await expect
      .poll(() => feed.getQuote())
      .toMatchObject({ exchange: 'gemini', bid: 3_412.25, ask: 3_412.75, mid: 3_412.5 })
    feed.close()
  })

  it('closes a feed whose fragmented message exceeds maxPayload', async ({ skip }) => {
    const httpServer = createServer()
    httpServers.push(httpServer)
    try {
      await new Promise<void>((resolve, reject) => {
        httpServer.once('error', reject)
        httpServer.listen(0, '127.0.0.1', resolve)
      })
    } catch (error) {
      if ((error as NodeJS.ErrnoException).code === 'EPERM') {
        skip()
        return
      }
      throw error
    }
    const server = new WebSocketServer({ server: httpServer })
    servers.push(server)
    const address = httpServer.address()
    if (address === null || typeof address === 'string') throw new Error('missing test server port')

    server.on('connection', (socket) => {
      const fragment = Buffer.alloc(1_024, 0x61)
      const fragments = CEX_MAX_PAYLOAD_BYTES / fragment.length + 1
      for (let index = 0; index < fragments; index += 1) {
        socket.send(fragment, { fin: index === fragments - 1 })
      }
    })

    const client = new WebSocket(`ws://127.0.0.1:${address.port}`, {
      maxPayload: CEX_MAX_PAYLOAD_BYTES,
    })
    clients.push(client)
    const error = new Promise<Error>((resolve) => client.once('error', resolve))
    const close = new Promise<number>((resolve) => client.once('close', resolve))

    await expect(error).resolves.toMatchObject({ code: 'WS_ERR_UNSUPPORTED_MESSAGE_LENGTH' })
    expect([1006, 1009]).toContain(await close)
  })
})
