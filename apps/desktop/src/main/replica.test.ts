import { mkdtempSync, rmSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { DatabaseSync } from 'node:sqlite'
import { expect, it } from 'vitest'
import { Replica } from './replica'

it('preserves text around embedded NULs for legacy rows and new body upserts', () => {
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
    expect(replica.triageAccount(null, arrivals)).toBe('one')

    const bucket = { bucket: 'Reply' as const, reason: 'Fixture', setAt: 50, setBy: 'triage-host' }
    replica.apply([
      upsert({ ...thread, lastMessageAt: 11, bucket }),
      upsert({ ...thread, id: 'snapshot', bucket: { ...bucket, setAt: 60, setBy: 'owner' } }),
    ])
    expect(replica.latestTriageBucketAt()).toBe(50)
    expect(replica.triageAccount(null, arrivals)).toBeUndefined()
  } finally {
    replica.db.close()
  }
})
