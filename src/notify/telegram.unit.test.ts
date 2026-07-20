import { describe, expect, it, vi } from 'vitest'

import { createTelegramNotifier } from './telegram'

describe('createTelegramNotifier', () => {
  it('is a no-op when token/chat are missing', async () => {
    const fetchFn = vi.fn()
    const n = createTelegramNotifier(
      { TELEGRAM_BOT_TOKEN: undefined, TELEGRAM_CHAT_ID: undefined },
      fetchFn as never,
    )
    await n.notify('hi')
    expect(fetchFn).not.toHaveBeenCalled()
  })

  it('posts to the Bot API sendMessage endpoint with chat id + text', async () => {
    const fetchFn = vi.fn().mockResolvedValue({ ok: true })
    const n = createTelegramNotifier(
      { TELEGRAM_BOT_TOKEN: 'T', TELEGRAM_CHAT_ID: '42' },
      fetchFn as never,
    )
    await n.notify('hello')
    expect(fetchFn).toHaveBeenCalledTimes(1)
    const [url, opts] = fetchFn.mock.calls[0]
    expect(url).toBe('https://api.telegram.org/botT/sendMessage')
    expect(JSON.parse(opts.body)).toMatchObject({ chat_id: '42', text: 'hello' })
  })

  it('never throws when fetch rejects', async () => {
    const token = ['123456789', 'ABCDEFGHIJKLMNOPQRSTUVWXYZabcdefghi'].join(':')
    const fetchFn = vi
      .fn()
      .mockRejectedValue(new Error(`network https://api.telegram.org/bot${token}/sendMessage`))
    const error = vi.spyOn(console, 'error').mockImplementation(() => undefined)
    const n = createTelegramNotifier(
      { TELEGRAM_BOT_TOKEN: token, TELEGRAM_CHAT_ID: '42' },
      fetchFn as never,
    )
    await expect(n.notify('x')).resolves.toBeUndefined()
    const output = error.mock.calls.flat().join(' ')
    expect(output).not.toContain(token)
    expect(output).toContain('notify error')
    error.mockRestore()
  })
})
