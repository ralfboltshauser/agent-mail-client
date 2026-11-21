import type { AccountSummary, MessageDetail, SyncChange, ThreadSummary } from '@amc/protocol'
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import {
  DEFAULT_NOTIFICATION_SETTINGS,
  inQuietHours,
  NewMailNotifications,
  newInboxMessages,
  parseNotificationSettings,
} from './notifications'
import { Replica } from './replica'

const startedAt = 1000
const account: AccountSummary = {
  id: 'a',
  kind: 'gmail',
  address: 'me@example.com',
  displayName: null,
  status: 'ready',
  lastSyncAt: null,
  lastError: null,
  messageCount: 0,
  backfill: { phase: 'done', fetched: 0, estimatedTotal: null },
}
const thread: ThreadSummary = {
  id: 't',
  accountId: 'a',
  inInbox: true,
  muted: false,
  snoozedUntil: null,
  subject: 'Subject',
  snippet: 'Snippet',
  participants: [],
  messageCount: 1,
  unreadCount: 1,
  starred: false,
  hasAttachments: false,
  labelIds: ['a:INBOX'],
  lastMessageAt: startedAt + 1,
}

function message(id: string, overrides: Partial<MessageDetail> = {}): MessageDetail {
  return {
    id,
    accountId: 'a',
    threadId: 't',
    rfcMessageId: null,
    inReplyTo: null,
    from: { address: 'sender@example.com', name: 'Sender' },
    to: [],
    cc: [],
    bcc: [],
    replyTo: [],
    subject: 'Subject',
    snippet: 'Snippet',
    bodyText: '',
    hasHtml: false,
    sentAt: startedAt + 1,
    unread: true,
    starred: false,
    labelIds: ['a:INBOX'],
    listUnsubscribe: null,
    attachments: [],
    ...overrides,
  }
}

function change(data: MessageDetail): SyncChange {
  return { modseq: 1, entity: 'message', op: 'upsert', id: data.id, data }
}

let replica: Replica
beforeEach(() => {
  replica = new Replica(':memory:')
  replica.put('account', account)
  replica.put('thread', thread)
})
afterEach(() => {
  replica.db.close()
  vi.useRealTimers()
})

describe('new Inbox mail', () => {
  it('requires a new unread Inbox message after startup from someone other than an owner', () => {
    replica.put('account', { ...account, id: 'b', address: 'other@example.com' })
    replica.put('message', message('existing', { unread: false }))
    const changes = [
      message('existing'),
      message('old', { sentAt: startedAt }),
      message('read', { unread: false }),
      message('archived', { labelIds: [] }),
      message('spam', { labelIds: ['a:INBOX', 'a:SPAM'] }),
      message('trash', { labelIds: ['a:INBOX', 'a:TRASH'] }),
      message('sent', { labelIds: ['a:INBOX', 'a:SENT'] }),
      message('self', { from: { address: 'ME@example.com', name: null } }),
      message('other-self', { from: { address: 'other@example.com', name: null } }),
      message('new'),
    ].map(change)
    expect(newInboxMessages(replica, changes, startedAt)).toEqual([{ id: 'new', threadId: 't' }])
    replica.apply(changes)
    expect(newInboxMessages(replica, changes, startedAt)).toEqual([])
  })

  it('skips mail from an Account whose initial backfill is in progress', () => {
    replica.put('account', {
      ...account,
      status: 'backfilling',
      backfill: { ...account.backfill, phase: 'all' },
    })
    const changes = [change(message('new'))]
    expect(newInboxMessages(replica, changes, startedAt)).toEqual([])
    replica.apply(changes)
    replica.put('account', account)
    expect(newInboxMessages(replica, changes, startedAt)).toEqual([])
  })
})

describe('quiet hours', () => {
  const defaults = DEFAULT_NOTIFICATION_SETTINGS
  const at = (hours: number, minutes = 0) => new Date(2026, 10, 21, hours, minutes)
  const quiet = (quietStart: string, quietEnd: string) => ({ ...defaults, quietStart, quietEnd })

  it('uses local time and includes the start but excludes the end', () => {
    expect(inQuietHours(defaults, at(10))).toBe(false)
    expect(inQuietHours(quiet('09:00', '11:00'), at(8, 59))).toBe(false)
    expect(inQuietHours(quiet('09:00', '11:00'), at(9))).toBe(true)
    expect(inQuietHours(quiet('09:00', '11:00'), at(11))).toBe(false)
    expect(inQuietHours(quiet('09:00', '09:00'), at(9))).toBe(false)
  })

  it('wraps across midnight and validates the pair of times', () => {
    const overnight = quiet('22:00', '07:00')
    expect(inQuietHours(overnight, at(21, 59))).toBe(false)
    expect(inQuietHours(overnight, at(22))).toBe(true)
    expect(inQuietHours(overnight, at(0))).toBe(true)
    expect(inQuietHours(overnight, at(7))).toBe(false)
    expect(parseNotificationSettings(overnight)).toEqual(overnight)
    expect(() => parseNotificationSettings(quiet('22:00', ''))).toThrow()
    expect(() => parseNotificationSettings(quiet('25:00', '07:00'))).toThrow()
  })
})

describe('notification batching', () => {
  const setup = () => {
    vi.useFakeTimers()
    vi.setSystemTime(new Date(2026, 10, 21, 12))
    const settings = { ...DEFAULT_NOTIFICATION_SETTINGS }
    const show = vi.fn()
    const batch = new NewMailNotifications(replica, () => settings, show)
    const add = (...messages: MessageDetail[]) => {
      const changes = messages.map(change)
      const candidates = newInboxMessages(replica, changes, startedAt)
      replica.apply(changes)
      batch.add(candidates)
    }
    return { show, settings, add }
  }

  it('coalesces four arrivals across sync pages, and starts a new window afterward', () => {
    const { show, add } = setup()
    add(message('1'))
    vi.advanceTimersByTime(9000)
    add(message('2'), message('3'), message('4'))
    expect(show).not.toHaveBeenCalled()
    vi.advanceTimersByTime(1000)
    expect(show).toHaveBeenCalledExactlyOnceWith({ title: '4 new messages', threadId: 't' })
    add(message('5'))
    vi.advanceTimersByTime(10_000)
    expect(show).toHaveBeenLastCalledWith({
      title: 'Sender',
      subtitle: 'Subject',
      body: 'Snippet',
      threadId: 't',
    })
  })

  it('shows three separate notifications and respects the current snippet setting', () => {
    const { show, settings, add } = setup()
    add(message('1'), message('2'), message('3'))
    settings.showSnippet = false
    vi.advanceTimersByTime(10_000)
    expect(show).toHaveBeenCalledTimes(3)
    expect(show).toHaveBeenLastCalledWith({
      title: 'Sender',
      subtitle: 'Subject',
      body: undefined,
      threadId: 't',
    })
  })

  it('drops arrivals during quiet hours and batches that reach quiet hours', () => {
    const { show, settings, add } = setup()
    settings.quietStart = '12:01'
    settings.quietEnd = '12:02'
    vi.setSystemTime(new Date(2026, 10, 21, 12, 0, 55))
    add(message('1'))
    vi.advanceTimersByTime(10_000)
    add(message('2'))
    vi.advanceTimersByTime(60_000)
    expect(show).not.toHaveBeenCalled()
  })

  it('drops a message read locally before delivery and respects disabled settings', () => {
    const { show, settings, add } = setup()
    add(message('1'))
    replica.organise.enqueue({ kind: 'read', threadId: thread.id, value: true })
    vi.advanceTimersByTime(10_000)
    settings.enabled = false
    add(message('2'))
    vi.advanceTimersByTime(10_000)
    expect(show).not.toHaveBeenCalled()
  })

  it('suppresses a muted thread at arrival and a thread muted before delivery', () => {
    const { show, add } = setup()
    replica.put('thread', { ...thread, muted: true, inInbox: false })
    add(message('1'))
    replica.put('thread', { ...thread, messageCount: 2 })
    vi.advanceTimersByTime(10_000)
    add(message('2'))
    replica.organise.enqueue({ kind: 'mute', threadId: thread.id, value: true })
    vi.advanceTimersByTime(10_000)
    expect(show).not.toHaveBeenCalled()
  })
})
