import { describe, expect, it } from 'vitest'

import { pickChatFromUpdates } from './telegramOnboard'

describe('pickChatFromUpdates', () => {
  it('returns null with no updates', () => {
    expect(pickChatFromUpdates([])).toBeNull()
  })

  it('extracts a private DM chat', () => {
    const got = pickChatFromUpdates([
      { message: { chat: { id: 12345, type: 'private', first_name: 'Alice' } } },
    ])
    expect(got).toEqual({ id: '12345', label: 'private: Alice' })
  })

  it('extracts a channel from channel_post and preserves negative ids', () => {
    const got = pickChatFromUpdates([
      { channel_post: { chat: { id: -1001234567890, type: 'channel', title: 'My Alerts' } } },
    ])
    expect(got).toEqual({ id: '-1001234567890', label: 'channel: My Alerts' })
  })

  it('detects a group via my_chat_member (bot just added)', () => {
    const got = pickChatFromUpdates([
      { my_chat_member: { chat: { id: -42, type: 'group', title: 'Desk' } } },
    ])
    expect(got).toEqual({ id: '-42', label: 'group: Desk' })
  })

  it('prefers the most recent update', () => {
    const got = pickChatFromUpdates([
      { message: { chat: { id: 1, type: 'private', first_name: 'Old' } } },
      { message: { chat: { id: 2, type: 'private', first_name: 'New' } } },
    ])
    expect(got?.id).toBe('2')
  })
})
