import { DatabaseSync } from 'node:sqlite'
import type {
  AccountSummary,
  Draft,
  Label,
  MessageDetail,
  SyncChange,
  SyncData,
  SyncEntity,
  ThreadSummary,
} from '@amc/protocol'
import type { Counts, ThreadQuery, ThreadWithMessages } from '../shared/api'

/**
 * The local copy of the owner's mail on the Mac (plan §5). Every read in the UI comes from
 * here, so it is instant; the sync loop keeps it in step with the Engine.
 */
export class Replica {
  readonly db: DatabaseSync

  constructor(path: string) {
    this.db = new DatabaseSync(path)
    this.db.exec(`
      PRAGMA journal_mode = WAL;
      PRAGMA synchronous = NORMAL;
      CREATE TABLE IF NOT EXISTS meta (key TEXT PRIMARY KEY, value TEXT NOT NULL);
      CREATE TABLE IF NOT EXISTS account (id TEXT PRIMARY KEY, data TEXT NOT NULL);
      CREATE TABLE IF NOT EXISTS label (id TEXT PRIMARY KEY, account_id TEXT NOT NULL, data TEXT NOT NULL);
      CREATE TABLE IF NOT EXISTS thread (
        id TEXT PRIMARY KEY, account_id TEXT NOT NULL, last_message_at INTEGER NOT NULL,
        in_inbox INTEGER NOT NULL, unread_count INTEGER NOT NULL, starred INTEGER NOT NULL,
        label_ids TEXT NOT NULL, haystack TEXT NOT NULL, data TEXT NOT NULL
      );
      CREATE INDEX IF NOT EXISTS thread_recent ON thread (last_message_at DESC);
      CREATE INDEX IF NOT EXISTS thread_inbox ON thread (in_inbox, last_message_at DESC);
      CREATE TABLE IF NOT EXISTS message (id TEXT PRIMARY KEY, thread_id TEXT NOT NULL, sent_at INTEGER NOT NULL, data TEXT NOT NULL);
      CREATE INDEX IF NOT EXISTS message_thread ON message (thread_id, sent_at);
      CREATE TABLE IF NOT EXISTS draft (id TEXT PRIMARY KEY, thread_id TEXT, updated_at INTEGER NOT NULL, data TEXT NOT NULL);
      CREATE TABLE IF NOT EXISTS html (message_id TEXT PRIMARY KEY, html TEXT NOT NULL);
    `)
  }

  get modseq(): number | null {
    const row = this.db.prepare("SELECT value FROM meta WHERE key = 'modseq'").get() as
      | { value: string }
      | undefined
    return row ? Number(row.value) : null
  }

  set modseq(value: number | null) {
    if (value === null) this.db.prepare("DELETE FROM meta WHERE key = 'modseq'").run()
    else
      this.db
        .prepare(
          "INSERT INTO meta (key, value) VALUES ('modseq', ?) ON CONFLICT (key) DO UPDATE SET value = excluded.value",
        )
        .run(String(value))
  }

  clear(): void {
    this.db.exec(
      'DELETE FROM account; DELETE FROM label; DELETE FROM thread; DELETE FROM message; DELETE FROM draft; DELETE FROM html; DELETE FROM meta;',
    )
  }

  transaction(fn: () => void): void {
    this.db.exec('BEGIN')
    try {
      fn()
      this.db.exec('COMMIT')
    } catch (error) {
      this.db.exec('ROLLBACK')
      throw error
    }
  }

  put<E extends SyncEntity>(entity: E, row: SyncData[E]): void {
    switch (entity) {
      case 'account': {
        const a = row as AccountSummary
        this.db
          .prepare('INSERT OR REPLACE INTO account (id, data) VALUES (?, ?)')
          .run(a.id, JSON.stringify(a))
        break
      }
      case 'label': {
        const l = row as Label
        this.db
          .prepare('INSERT OR REPLACE INTO label (id, account_id, data) VALUES (?, ?, ?)')
          .run(l.id, l.accountId, JSON.stringify(l))
        break
      }
      case 'thread': {
        const t = row as ThreadSummary
        const haystack = [
          t.subject,
          t.snippet,
          ...t.participants.flatMap((p) => [p.name ?? '', p.address]),
        ]
          .join(' ')
          .toLowerCase()
        this.db
          .prepare(
            `INSERT OR REPLACE INTO thread (id, account_id, last_message_at, in_inbox, unread_count, starred, label_ids, haystack, data)
             VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?)`,
          )
          .run(
            t.id,
            t.accountId,
            t.lastMessageAt,
            t.inInbox ? 1 : 0,
            t.unreadCount,
            t.starred ? 1 : 0,
            JSON.stringify(t.labelIds),
            haystack,
            JSON.stringify(t),
          )
        break
      }
      case 'message': {
        const m = row as MessageDetail
        this.db
          .prepare(
            'INSERT OR REPLACE INTO message (id, thread_id, sent_at, data) VALUES (?, ?, ?, ?)',
          )
          .run(m.id, m.threadId, m.sentAt, JSON.stringify(m))
        break
      }
      case 'draft': {
        const d = row as Draft
        this.db
          .prepare(
            'INSERT OR REPLACE INTO draft (id, thread_id, updated_at, data) VALUES (?, ?, ?, ?)',
          )
          .run(d.id, d.threadId, d.updatedAt, JSON.stringify(d))
        break
      }
    }
  }

  remove(entity: SyncEntity, id: string): void {
    this.db.prepare(`DELETE FROM ${entity} WHERE id = ?`).run(id)
    if (entity === 'message') this.db.prepare('DELETE FROM html WHERE message_id = ?').run(id)
  }

  apply(changes: SyncChange[]): void {
    for (const change of changes) {
      if (change.op === 'upsert') this.put(change.entity, change.data)
      else this.remove(change.entity, change.id)
    }
  }

  // ── reads ──────────────────────────────────────────────────────────────

  accounts(): AccountSummary[] {
    return (
      this.db.prepare('SELECT data FROM account ORDER BY rowid').all() as { data: string }[]
    ).map((r) => JSON.parse(r.data))
  }

  labels(accountId: string | null): Label[] {
    return (
      this.db
        .prepare('SELECT data FROM label WHERE (?1 IS NULL OR account_id = ?1)')
        .all(accountId) as { data: string }[]
    ).map((r) => JSON.parse(r.data))
  }

  threads(query: ThreadQuery): ThreadSummary[] {
    const where: string[] = []
    const params: (string | number)[] = []
    if (query.accountId) {
      where.push('account_id = ?')
      params.push(query.accountId)
    }
    const hasLabel = (suffix: string) => {
      where.push(`EXISTS (SELECT 1 FROM json_each(label_ids) WHERE value LIKE ?)`)
      params.push(`%:${suffix}`)
    }
    switch (query.view.kind) {
      case 'inbox':
        where.push('in_inbox = 1')
        break
      case 'unread':
        where.push('in_inbox = 1 AND unread_count > 0')
        break
      case 'starred':
        where.push('starred = 1')
        break
      case 'sent':
        hasLabel('SENT')
        break
      case 'drafts':
        hasLabel('DRAFT')
        break
      case 'label':
        where.push('EXISTS (SELECT 1 FROM json_each(label_ids) WHERE value = ?)')
        params.push(query.view.labelId)
        break
      case 'all':
        where.push(
          `NOT EXISTS (SELECT 1 FROM json_each(label_ids) WHERE value LIKE '%:SPAM' OR value LIKE '%:TRASH')`,
        )
        break
    }
    const rows = this.db
      .prepare(
        `SELECT data FROM thread ${where.length ? `WHERE ${where.join(' AND ')}` : ''}
         ORDER BY last_message_at DESC LIMIT ?`,
      )
      .all(...params, query.limit ?? 5000) as { data: string }[]
    return rows.map((r) => JSON.parse(r.data))
  }

  thread(id: string): ThreadWithMessages | null {
    const row = this.db.prepare('SELECT data FROM thread WHERE id = ?').get(id) as
      | { data: string }
      | undefined
    if (!row) return null
    const messages = (
      this.db.prepare('SELECT data FROM message WHERE thread_id = ? ORDER BY sent_at').all(id) as {
        data: string
      }[]
    ).map((r) => JSON.parse(r.data) as MessageDetail)
    const drafts = (
      this.db
        .prepare('SELECT data FROM draft WHERE thread_id = ? ORDER BY updated_at DESC')
        .all(id) as { data: string }[]
    ).map((r) => JSON.parse(r.data) as Draft)
    return { thread: JSON.parse(row.data), messages, drafts }
  }

  unreadInboxCount(): number {
    const row = this.db
      .prepare('SELECT count(*) AS n FROM thread WHERE in_inbox = 1 AND unread_count > 0')
      .get() as { n: number }
    return row.n
  }

  counts(accountId: string | null): Counts {
    const row = this.db
      .prepare(
        `SELECT
           sum(in_inbox) AS inbox,
           sum(CASE WHEN in_inbox = 1 AND unread_count > 0 THEN 1 ELSE 0 END) AS inbox_unread,
           sum(starred) AS starred
         FROM thread WHERE (?1 IS NULL OR account_id = ?1)`,
      )
      .get(accountId) as {
      inbox: number | null
      inbox_unread: number | null
      starred: number | null
    }
    const drafts = this.db
      .prepare(
        `SELECT count(*) AS n FROM thread WHERE (?1 IS NULL OR account_id = ?1)
         AND EXISTS (SELECT 1 FROM json_each(label_ids) WHERE value LIKE '%:DRAFT')`,
      )
      .get(accountId) as { n: number }
    return {
      inbox: row.inbox ?? 0,
      inboxUnread: row.inbox_unread ?? 0,
      starred: row.starred ?? 0,
      drafts: drafts.n,
    }
  }

  filter(text: string, accountId: string | null): ThreadSummary[] {
    const words = text.toLowerCase().split(/\s+/).filter(Boolean)
    if (words.length === 0) return []
    const rows = this.db
      .prepare(
        `SELECT data FROM thread WHERE (?1 IS NULL OR account_id = ?1)
         ${words.map(() => 'AND haystack LIKE ?').join(' ')}
         ORDER BY last_message_at DESC LIMIT 200`,
      )
      .all(accountId, ...words.map((w) => `%${w.replace(/[%_]/g, '')}%`)) as { data: string }[]
    return rows.map((r) => JSON.parse(r.data))
  }

  html(messageId: string): string | null {
    const row = this.db.prepare('SELECT html FROM html WHERE message_id = ?').get(messageId) as
      | { html: string }
      | undefined
    return row?.html ?? null
  }

  putHtml(messageId: string, html: string): void {
    this.db
      .prepare('INSERT OR REPLACE INTO html (message_id, html) VALUES (?, ?)')
      .run(messageId, html)
  }
}
