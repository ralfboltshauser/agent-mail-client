import { mkdtempSync, rmSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { DatabaseSync } from 'node:sqlite'
import { MessageDetail, TRIAGE_RECENT_WINDOW_MS } from '@amc/protocol'
import { expect, it, vi } from 'vitest'
import { Replica } from './replica'

it('splits legacy bodies off the read path and preserves text around embedded NULs', async () => {
  const dir = mkdtempSync(join(tmpdir(), 'amc-replica-'))
  const path = join(dir, 'replica.sqlite')
  const bodyText = 'before 🌱\0after 東京'
  const message = { id: 'm1', threadId: 't1', sentAt: 0, bodyText }

  try {
    const legacy = new DatabaseSync(path)
    try {
      legacy.exec(
        'CREATE TABLE message (id TEXT PRIMARY KEY, thread_id TEXT NOT NULL, sent_at INTEGER NOT NULL, data TEXT NOT NULL)',
      )
      legacy
        .prepare('INSERT INTO message (id, thread_id, sent_at, data) VALUES (?, ?, ?, ?)')
        .run(message.id, message.threadId, message.sentAt, JSON.stringify(message))
    } finally {
      legacy.close()
    }

    const replica = new Replica(path)
    try {
      expect(replica.messageText(message.id)).toBe(bodyText)
      const row = replica.db.prepare('SELECT data, body_text IS NULL AS legacy FROM message')
      expect(row.get()?.legacy).toBe(1)
      await vi.waitFor(() => expect(row.get()?.legacy).toBe(0))
      expect(JSON.parse(String(row.get()?.data))).not.toHaveProperty('bodyText')
      expect(replica.messageText(message.id)).toBe(bodyText)
      const updated = `${bodyText}\0updated`
      replica.put('message', { ...message, bodyText: updated } as Parameters<
        typeof replica.put<'message'>
      >[1])
      expect(replica.messageText(message.id)).toBe(updated)
    } finally {
      replica.db.close()
    }
  } finally {
    rmSync(dir, { recursive: true, force: true })
  }
})

it('triggers triage for new Inbox mail and recognizes synced triage grant assignments', () => {
  const replica = new Replica(':memory:')
  try {
    const thread = {
      id: 'new',
      accountId: 'one',
      subject: '',
      snippet: '',
      participants: [],
      messageCount: 1,
      unreadCount: 1,
      starred: false,
      inInbox: true,
      hasAttachments: false,
      labelIds: [],
      lastMessageAt: 10,
      snoozedUntil: null,
      muted: false,
    }
    const upsert = (data: Parameters<typeof replica.put<'thread'>>[1]) => ({
      modseq: 1,
      op: 'upsert' as const,
      entity: 'thread' as const,
      id: data.id,
      data,
    })
    replica.put('thread', { ...thread, id: 'snapshot' })
    const arrivals = replica.apply([upsert(thread), upsert({ ...thread, unreadCount: 0 })])
    expect(arrivals).toEqual(new Map([['new', 'one']]))
    expect(replica.apply([upsert({ ...thread, starred: true })]).size).toBe(0)
    expect(replica.apply([upsert({ ...thread, lastMessageAt: 11 })]).size).toBe(1)
    const now = Date.now()
    const putMessage = (threadId: string, deliveredAt?: number) => {
      replica.put('message', {
        id: threadId,
        threadId,
        sentAt: now,
        deliveredAt,
        bodyText: '',
      } as Parameters<typeof replica.put<'message'>>[1])
    }
    putMessage('new', now - TRIAGE_RECENT_WINDOW_MS + 60_000)
    putMessage('snapshot', now - TRIAGE_RECENT_WINDOW_MS - 60_000)
    replica.put('thread', { ...thread, id: 'unknown', accountId: 'two', lastMessageAt: 100 })
    putMessage('unknown')
    expect(replica.triageCounts(null)).toEqual({ recent: 1, older: 2 })
    expect(replica.triageCounts('two')).toEqual({ recent: 0, older: 1 })
    expect(replica.triageAccount(null, arrivals, 'recent')).toBe('one')
    expect(replica.triageAccount(null, undefined, 'recent')).toBe('one')
    expect(replica.triageAccount(null, undefined, 'account')).toBe('two')
    expect(replica.triageAccount(null, undefined, 'older')).toBe('two')

    const bucket = { bucket: 'Reply' as const, reason: 'Fixture', setAt: 50, setBy: 'triage-host' }
    replica.apply([upsert({ ...thread, lastMessageAt: 11, bucket })])
    expect(replica.triageAccount(null, arrivals, 'recent')).toBeUndefined()
    expect(replica.triageCounts(null)).toEqual({ recent: 0, older: 2 })
  } finally {
    replica.db.close()
  }
})

it('keeps cached HTML through label changes and invalidates it when its known source changes', () => {
  const replica = new Replica(':memory:')
  const message = MessageDetail.parse({
    id: 'm1',
    threadId: 't1',
    accountId: 'one',
    rfcMessageId: null,
    inReplyTo: null,
    from: null,
    to: [],
    cc: [],
    bcc: [],
    replyTo: [],
    subject: 'Synthetic message',
    snippet: '',
    sentAt: 0,
    unread: false,
    starred: false,
    labelIds: [],
    listUnsubscribe: null,
    bodyText: 'Initial text',
    hasHtml: true,
    attachments: [],
  })

  try {
    replica.put('message', message)
    const source = replica.htmlSource(message.id)
    replica.putHtml(message.id, '<p>Initial HTML</p>')
    replica.put('message', { ...message, unread: true })
    expect(replica.htmlSource(message.id)).toBe(source)
    expect(replica.html(message.id)).toBe('<p>Initial HTML</p>')

    replica.put('message', { ...message, bodyText: 'Updated text' })
    expect(replica.htmlSource(message.id)).not.toBe(source)
    expect(replica.html(message.id)).toBeNull()
  } finally {
    replica.db.close()
  }
})

it('skips oversized cached HTML during preparation and keeps it available to the reader', () => {
  const replica = new Replica(':memory:')
  try {
    const html = '<p>é</p>'
    replica.putHtml('cached-message', html)
    expect(replica.html('cached-message', html.length)).toBeNull()
    expect(replica.html('cached-message', Buffer.byteLength(html))).toBe(html)
    expect(replica.html('cached-message')).toBe(html)
  } finally {
    replica.db.close()
  }
})
