import { describe, expect, it } from 'vitest'

import { summarizeUnhandledRequest } from './setup-tests'

describe('isolated unit-test environment', () => {
  it('does not expose inherited operator-shaped secret variables', () => {
    expect(process.env.BOT_PRIVATE_KEY).toBeUndefined()
    expect(process.env.BOT_KEYSTORE_PASSPHRASE).toBeUndefined()
    expect(process.env.RPC_URL).toBeUndefined()
    expect(process.env.TELEGRAM_BOT_TOKEN).toBeUndefined()
  })

  it('summarizes unhandled requests without credentials or paths', () => {
    const summary = summarizeUnhandledRequest(
      new Request('https://unhandled.invalid/private/token?credential=synthetic-password'),
    )
    expect(summary).toBe('GET https://unhandled.invalid/[redacted]')
    expect(summary).not.toContain('synthetic-password')
    expect(summary).not.toContain('private/token')
  })
})
