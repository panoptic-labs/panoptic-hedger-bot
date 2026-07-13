import type { HedgerBotConfig } from '../config'

export interface Notifier {
  /** Send a notification. Never throws — notification failures must not break the loop. */
  notify(message: string): Promise<void>
}

/**
 * Telegram notifier via the Bot API (plain fetch, no dependency). Returns a
 * no-op notifier when the bot token / chat id are not configured.
 *
 * Create a bot with @BotFather to get TELEGRAM_BOT_TOKEN; TELEGRAM_CHAT_ID is
 * the destination chat/channel/group id.
 */
export function createTelegramNotifier(
  config: Pick<HedgerBotConfig, 'TELEGRAM_BOT_TOKEN' | 'TELEGRAM_CHAT_ID'>,
  fetchFn: typeof fetch = fetch,
): Notifier {
  const token = config.TELEGRAM_BOT_TOKEN
  const chatId = config.TELEGRAM_CHAT_ID

  if (!token || !chatId) {
    return { notify: async () => {} }
  }

  const url = `https://api.telegram.org/bot${token}/sendMessage`
  const TIMEOUT_MS = 10_000

  return {
    async notify(message: string): Promise<void> {
      // Bound the request so a slow/unreachable Telegram API cannot stall the
      // hedge loop or startup.
      const controller = new AbortController()
      const timer = setTimeout(() => controller.abort(), TIMEOUT_MS)
      try {
        const res = await fetchFn(url, {
          method: 'POST',
          headers: { 'content-type': 'application/json' },
          body: JSON.stringify({ chat_id: chatId, text: message, disable_web_page_preview: true }),
          signal: controller.signal,
        })
        if (!res.ok) {
          const body = await res.text().catch(() => '')
          console.error(`[telegram] sendMessage failed: ${res.status} ${body}`)
        }
      } catch (err) {
        console.error('[telegram] notify error', err)
      } finally {
        clearTimeout(timer)
      }
    },
  }
}
