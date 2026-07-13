import dotenv from 'dotenv'
import { setupServer } from 'msw/node'

dotenv.config()

// Create and export the MSW server instance for mocking http responses
export const server = setupServer()

const unhandledRequests = new Map<string, { request?: Request; response?: Response }>()

// Save and log any unhandled requests / response pairs (ignoring any localhost requests)
server.events.on('request:unhandled', async ({ request, requestId }) => {
  if (new URL(request.url).hostname !== '127.0.0.1') {
    unhandledRequests.set(requestId, { request })
  }
})

server.events.on('response:bypass', async ({ response, request, requestId }) => {
  if (new URL(request.url).hostname !== '127.0.0.1') {
    const existingRequest = unhandledRequests.get(requestId) || {}
    unhandledRequests.set(requestId, { ...existingRequest, response })
  }
})

afterAll(() => {
  if (unhandledRequests.size > 0) {
    console.log('Unhandled Requests')
    console.log(unhandledRequests)
    console.log(
      "It's recommended to save these responses and use MSW to mock them to avoid making network requests in tests.",
    )
  }
})
