import { describe, expect, it } from 'vitest'

import { SANITIZED_ERROR_MAX_LENGTH, sanitizeError, sanitizeText } from './sanitize'

describe('secret-safe output sanitization', () => {
  it('removes synthetic RPC, URL, Telegram, authorization, and transaction credentials', () => {
    const secrets = [
      'rpc-path-token-123456',
      'query-token-654321',
      'user-name',
      'user-password',
      '123456789:ABCDEFGHIJKLMNOPQRSTUVWXYZabcdefghi',
      'Bearer synthetic-authorization-token',
      `0x${'ab'.repeat(180)}`,
    ]
    const credentialedRpcUrl = [
      'https:/',
      '/user-name',
      ':user-password',
      '@rpc.example/v2/rpc-path-token-123456?key=query-token-654321',
    ].join('')
    const authorization = ['authorization:', 'Bearer', 'synthetic-authorization-token'].join(' ')
    const telegramUrl = [
      'https://api.telegram.org/',
      'bot123456789',
      ':ABCDEFGHIJKLMNOPQRSTUVWXYZabcdefghi/sendMessage',
    ].join('')
    const fixture = [
      `POST ${credentialedRpcUrl}`,
      authorization,
      `telegram ${telegramUrl}`,
      `requestBody: {"rawTransaction":"0x${'ab'.repeat(180)}"}`,
    ].join('\n')

    const output = sanitizeError(new Error(fixture))

    for (const secret of secrets) expect(output).not.toContain(secret)
    expect(output).toContain('rpc.example')
    expect(output.length).toBeLessThanOrEqual(SANITIZED_ERROR_MAX_LENGTH)
  })

  it('prefers protocol short messages while bounding nested causes', () => {
    const deepest = new Error('deep https://rpc.example/path/credential')
    const middle = new Error('middle')
    Object.defineProperty(middle, 'cause', { value: deepest })
    const outer = new Error('verbose request body that must not win')
    Object.defineProperties(outer, {
      name: { value: 'ContractFunctionExecutionError' },
      shortMessage: { value: 'Execution reverted with custom error PriceBoundFail()' },
      cause: { value: middle },
    })

    const output = sanitizeError(outer)

    expect(output).toContain('PriceBoundFail')
    expect(output).not.toContain('verbose request body')
    expect(output).not.toContain('credential')
  })

  it('bounds arbitrary notification text', () => {
    expect(sanitizeText('x'.repeat(2_000)).length).toBeLessThanOrEqual(SANITIZED_ERROR_MAX_LENGTH)
  })

  it('redacts secret keywords and bot tokens embedded in camelCase names', () => {
    const token = 'bot123456789:ABCDEFGHIJKLMNOPQRSTUVWXYZabcdefghi'
    const output = sanitizeText(`userApiKey=synthetic-key telegramApiKey=${token}`)

    expect(output).not.toContain('synthetic-key')
    expect(output).not.toContain(token)
  })
})
