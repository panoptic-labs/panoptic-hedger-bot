/**
 * Telegram onboarding helpers used by the setup wizard. Creating the bot itself
 * (@BotFather) and creating a channel cannot be automated via the Bot API — but
 * validating the token and discovering the destination chat id can, which is the
 * fiddly part. Plain fetch, no dependency.
 */

export interface DiscoveredChat {
  id: string
  /** Human label for confirmation, e.g. "channel: My Alerts" or "private: alice". */
  label: string
}

interface TgChat {
  id: number
  type: string
  title?: string
  username?: string
  first_name?: string
}

interface TgUpdate {
  message?: { chat: TgChat }
  channel_post?: { chat: TgChat }
  my_chat_member?: { chat: TgChat }
  chat_member?: { chat: TgChat }
}

/** Pure: pick the most recent chat referenced by a getUpdates response. */
export function pickChatFromUpdates(updates: TgUpdate[]): DiscoveredChat | null {
  for (let i = updates.length - 1; i >= 0; i--) {
    const u = updates[i]
    const chat =
      u.message?.chat ?? u.channel_post?.chat ?? u.my_chat_member?.chat ?? u.chat_member?.chat
    if (chat) {
      const name = chat.title ?? chat.username ?? chat.first_name ?? ''
      return { id: String(chat.id), label: `${chat.type}${name ? `: ${name}` : ''}` }
    }
  }
  return null
}

const TIMEOUT_MS = 10_000

async function tgGet(
  token: string,
  method: string,
  fetchFn: typeof fetch,
): Promise<{ ok: boolean; result?: unknown; description?: string }> {
  const controller = new AbortController()
  const timer = setTimeout(() => controller.abort(), TIMEOUT_MS)
  try {
    const res = await fetchFn(`https://api.telegram.org/bot${token}/${method}`, {
      signal: controller.signal,
    })
    return (await res.json()) as { ok: boolean; result?: unknown; description?: string }
  } catch {
    // Network failure / timeout (abort) — treat as a failed poll so callers can
    // retry or skip, matching sendTelegramTest rather than propagating.
    return { ok: false }
  } finally {
    clearTimeout(timer)
  }
}

/** Validate the token via getMe; returns the bot's @username or throws. */
export async function validateBotToken(
  token: string,
  fetchFn: typeof fetch = fetch,
): Promise<string> {
  const data = await tgGet(token, 'getMe', fetchFn)
  const result = data.result as { username?: string } | undefined
  if (!data.ok || !result?.username) {
    throw new Error(`invalid bot token: ${data.description ?? 'getMe failed'}`)
  }
  return result.username
}

/** One-shot: scan recent updates for a destination chat. Returns null if none yet. */
export async function discoverChat(
  token: string,
  fetchFn: typeof fetch = fetch,
): Promise<DiscoveredChat | null> {
  const data = await tgGet(token, 'getUpdates', fetchFn)
  if (!data.ok || !Array.isArray(data.result)) return null
  return pickChatFromUpdates(data.result as TgUpdate[])
}

/** Send a confirmation message; returns true on success. */
export async function sendTelegramTest(
  token: string,
  chatId: string,
  text: string,
  fetchFn: typeof fetch = fetch,
): Promise<boolean> {
  const controller = new AbortController()
  const timer = setTimeout(() => controller.abort(), TIMEOUT_MS)
  try {
    const res = await fetchFn(`https://api.telegram.org/bot${token}/sendMessage`, {
      method: 'POST',
      headers: { 'content-type': 'application/json' },
      body: JSON.stringify({ chat_id: chatId, text }),
      signal: controller.signal,
    })
    return res.ok
  } catch {
    return false
  } finally {
    clearTimeout(timer)
  }
}
