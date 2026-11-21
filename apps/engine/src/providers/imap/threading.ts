import { type IncomingMessage, type MailStore, threadId } from '../../mail/store.ts'

type ThreadHeaders = Pick<
  IncomingMessage,
  'providerId' | 'rfcMessageId' | 'references' | 'inReplyTo' | 'subject' | 'sentAt'
>

const SUBJECT_WINDOW_MS = 7 * 24 * 60 * 60 * 1000

function ids(header: string | null): string[] {
  if (!header) return []
  const bracketed = [...header.matchAll(/<([^<>\s]+@[^<>\s]+)>/g)].map((match) => match[1] ?? '')
  if (bracketed.length) return bracketed
  return header
    .trim()
    .split(/\s+/)
    .filter((id) => /^[^<>\s]+@[^<>\s]+$/.test(id))
}

function hints(message: ThreadHeaders) {
  const own = ids(message.rfcMessageId)[0]
  const references = ids(message.references)
  const parents = references.length ? references : ids(message.inReplyTo).slice(0, 1)
  return {
    keys: [...new Set([...parents, ...(own ? [own] : [])])],
    hasParent: parents.some((key) => key !== own),
    reply: /^\s*re\s*:/i.test(message.subject),
    subject: message.subject
      .replace(/^(\s*re\s*:\s*)+/i, '')
      .trim()
      .toLowerCase(),
  }
}

/** SQLite keeps reference containers (including missing ancestors) and nearby-subject lookups. */
export class ImapThreads {
  readonly store: MailStore
  readonly accountId: string

  constructor(store: MailStore, accountId: string) {
    this.store = store
    this.accountId = accountId
  }

  assign(message: ThreadHeaders, mid: string): string {
    const { db } = this.store
    const { keys, subject, reply, hasParent } = hints(message)
    const lookup = db.prepare(
      `SELECT t.provider_thread_id AS id FROM imap_thread_alias a JOIN thread t ON t.id = a.thread_id
       WHERE a.account_id = ? AND a.rfc_id = ?`,
    )
    const known = keys.flatMap((key) => {
      const row = lookup.get(this.accountId, key) as { id: string } | undefined
      return row ? [row.id] : []
    })
    const persisted = db
      .prepare(
        'SELECT t.provider_thread_id AS id FROM message m JOIN thread t ON t.id = m.thread_id WHERE m.id = ?',
      )
      .get(mid) as { id: string } | undefined
    let canonical = persisted?.id
    if (!canonical && !known.length && !hasParent && subject && message.sentAt > 0) {
      const nearby = db
        .prepare(
          `SELECT t.provider_thread_id AS id FROM imap_thread_subject s
         JOIN message m ON m.id = s.message_id JOIN thread t ON t.id = m.thread_id
         WHERE s.account_id = ? AND s.subject = ? AND s.sent_at > ? AND s.sent_at < ?
           AND s.sent_at > 0 AND (? OR (s.reply AND NOT s.has_parent))
         ORDER BY abs(s.sent_at - ?), m.rowid LIMIT 1`,
        )
        .get(
          this.accountId,
          subject,
          message.sentAt - SUBJECT_WINDOW_MS,
          message.sentAt + SUBJECT_WINDOW_MS,
          +reply,
          message.sentAt,
        ) as { id: string } | undefined
      canonical = nearby?.id
    }
    const thread =
      known[0] ??
      canonical ??
      (keys[0] ? `imap:${encodeURIComponent(keys[0])}` : `imap:local:${message.providerId}`)
    for (const candidate of new Set([...known, ...(canonical ? [canonical] : [])])) {
      if (candidate === thread) continue
      // Make the destination available before moving aliases off the source Thread.
      db.prepare(
        'INSERT OR IGNORE INTO thread (id, account_id, provider_thread_id) VALUES (?, ?, ?)',
      ).run(threadId(this.accountId, thread), this.accountId, thread)
      db.prepare('UPDATE imap_thread_alias SET thread_id = ? WHERE thread_id = ?').run(
        threadId(this.accountId, thread),
        threadId(this.accountId, candidate),
      )
      this.store.mergeThreads(this.accountId, candidate, thread)
    }
    return thread
  }

  restoreBucket(pathKey: string, message: ThreadHeaders, sourceBlob: string, mid: string): void {
    const { db } = this.store
    if (
      !db
        .prepare('SELECT 1 FROM imap_bucket_reimport WHERE account_id = ? AND path_key = ?')
        .get(this.accountId, pathKey)
    )
      return

    const keys = JSON.stringify([
      ...hints(message).keys.map((key) => `rfc:${key}`),
      `source:${sourceBlob}`,
    ])
    const match = db
      .prepare(`
      SELECT thread_key FROM imap_bucket_reimport
      WHERE account_id = ? AND path_key = ? AND identity IN (SELECT value FROM json_each(?))
      ORDER BY bucket_set_at DESC, thread_key LIMIT 1
    `)
      .get(this.accountId, pathKey, keys) as { thread_key: string } | undefined
    if (!match) return

    const restored = db
      .prepare(`
      UPDATE thread
      SET (bucket, bucket_reason, bucket_set_by, bucket_set_at) = (
        SELECT bucket, bucket_reason, bucket_set_by, bucket_set_at
        FROM imap_bucket_reimport WHERE account_id = ? AND path_key = ? AND thread_key = ?
        LIMIT 1
      )
      WHERE id = (SELECT thread_id FROM message WHERE id = ?) AND bucket IS NULL
      RETURNING id
    `)
      .get(this.accountId, pathKey, match.thread_key, mid) as { id: string } | undefined
    if (restored) this.store.recordChange('thread', restored.id, 'upsert')

    db.prepare(`
      DELETE FROM imap_bucket_reimport WHERE account_id = ?1 AND path_key = ?2 AND thread_key IN (
        SELECT thread_key FROM imap_bucket_reimport
        WHERE account_id = ?1 AND path_key = ?2 AND identity IN (SELECT value FROM json_each(?3))
      )
    `).run(this.accountId, pathKey, keys)
  }

  remember(message: IncomingMessage, mid: string): void {
    const { keys, subject, reply, hasParent } = hints(message)
    const { db } = this.store
    const alias = db.prepare(
      `INSERT INTO imap_thread_alias (account_id, rfc_id, thread_id) VALUES (?, ?, ?)
       ON CONFLICT (account_id, rfc_id) DO UPDATE SET thread_id = excluded.thread_id`,
    )
    for (const key of keys)
      alias.run(this.accountId, key, threadId(this.accountId, message.providerThreadId))
    if (subject)
      db.prepare(
        `INSERT OR REPLACE INTO imap_thread_subject (message_id, account_id, subject, sent_at, reply, has_parent)
       VALUES (?, ?, ?, ?, ?, ?)`,
      ).run(mid, this.accountId, subject, message.sentAt, +reply, +hasParent)
  }
}
