import { mkdtempSync, rmSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { DatabaseSync } from 'node:sqlite'
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
