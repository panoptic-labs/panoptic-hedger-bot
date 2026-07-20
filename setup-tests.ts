import { setupServer } from 'msw/node'

// Create and export the MSW server instance for mocking http responses
export const server = setupServer()
const unhandledRequests = new Set<string>()

const SECRET_ENV_NAME = /(private[_-]?key|passphrase|password|secret|token|rpc[_-]?url)/iu

// Unit tests must never inherit operator credentials. A suite may inject a
// synthetic value after setup when the behavior under test requires one.
for (const name of Object.keys(process.env)) {
  if (SECRET_ENV_NAME.test(name)) delete process.env[name]
}

export function summarizeUnhandledRequest(request: Request): string {
  const url = new URL(request.url)
  return `${request.method} ${url.origin}/[redacted]`
}

server.events.on('request:unhandled', ({ request }) => {
  unhandledRequests.add(summarizeUnhandledRequest(request))
})

beforeAll(() => {
  server.listen({
    onUnhandledRequest(request) {
      throw new Error(`Unhandled outbound request: ${summarizeUnhandledRequest(request)}`)
    },
  })
})

afterEach(() => {
  server.resetHandlers()
  if (unhandledRequests.size === 0) return
  const summaries = [...unhandledRequests]
  unhandledRequests.clear()
  throw new Error(`Test attempted unmocked outbound request(s): ${summaries.join(', ')}`)
})

afterAll(() => {
  server.close()
})
