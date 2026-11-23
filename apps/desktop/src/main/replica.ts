import { createHash } from 'node:crypto'
import { DatabaseSync } from 'node:sqlite'
import { newRunId } from '@amc/observability'
import type {
  AccountSummary,
  Bucket,
  Draft,
  Label,
  MessageDetail,
  SyncChange,
  SyncData,
  SyncEntity,
  ThreadSummary,
} from '@amc/protocol'
import { RECENT_THREAD_BODIES, TRIAGE_RECENT_WINDOW_MS } from '@amc/protocol'
import type {
  Counts,
  DesktopThreadSummary,
  ReplicaThreadMessage,
  ThreadQuery,
  ThreadWithMessages,
  TriageCounts,
} from '../shared/api'
import { LocalDraftUpdates } from './draft-updates'
import { mainLog, operationFailure } from './observability'
import { LocalOrganise, ORGANISE_SCHEMA } from './organise'

const UNTRIAGED_INBOX = "in_inbox = 1 AND json_extract(data, '$.bucket.bucket') IS NULL"
const RECENT_DELIVERY = `(
  SELECT MAX(json_extract(message.data, '$.deliveredAt'))
  FROM message WHERE message.thread_id = thread.id
) BETWEEN :cutoff AND :now`

const THREAD_LIST_COLUMNS = `data, (
  SELECT json_object('messageId', m.id, 'from', json_extract(m.data, '$.from'))
  FROM message m WHERE m.thread_id = effective_thread.id
  ORDER BY m.sent_at DESC, m.id DESC LIMIT 1
) AS latest_sender`

type ThreadListRow = {
  data: string
  latest_sender: string | null
}

function readThreadListRow(row: ThreadListRow): DesktopThreadSummary {
  const thread = JSON.parse(row.data) as DesktopThreadSummary
  if (row.latest_sender) thread.latestSender = JSON.parse(row.latest_sender)
  return thread
}

function triageWindow() {
  const now = Date.now()
  return { cutoff: now - TRIAGE_RECENT_WINDOW_MS, now }
}

function splitMessage({ bodyText, ...metadata }: MessageDetail) {
  const body = Buffer.from(bodyText, 'utf8')
  const bodyRevision = createHash('sha256').update(body).digest('hex')
  return { body, data: JSON.stringify({ ...metadata, bodyRevision }) }
}

/**
 * The local copy of the owner's mail on the Mac (plan §5). Every read in the UI comes from
 * here, so it is instant; the sync loop keeps it in step with the Engine.
 */
export class Replica {
  readonly db: DatabaseSync
  readonly organise: LocalOrganise
  readonly draftUpdates: LocalDraftUpdates

  constructor(path: string) {
    this.db = new DatabaseSync(path)
    this.db.exec(`
      PRAGMA journal_mode = WAL;
      PRAGMA synchronous = NORMAL;
      CREATE TABLE IF NOT EXISTS notified_message (
        account_id TEXT NOT NULL, message_id TEXT NOT NULL, PRIMARY KEY (account_id, message_id)
      );
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
    const messageColumns = this.db.prepare('PRAGMA table_info(message)').all()
    if (!messageColumns.some((column) => column.name === 'body_text')) {
      this.db.exec('ALTER TABLE message ADD COLUMN body_text BLOB')
    }
    this.db.exec(ORGANISE_SCHEMA)
    const columns = this.db.prepare('PRAGMA table_info(organise_queue)').all()
    if (!columns.some((column) => column.name === 'messages')) {
      this.db.exec('ALTER TABLE organise_queue ADD COLUMN messages TEXT')
    }
    if (!columns.some((column) => column.name === 'superseded')) {
      this.db.exec("ALTER TABLE organise_queue ADD COLUMN superseded TEXT NOT NULL DEFAULT '[]'")
    }
    if (!columns.some((column) => column.name === 'supersession_notified')) {
      this.db.exec(
        'ALTER TABLE organise_queue ADD COLUMN supersession_notified INTEGER NOT NULL DEFAULT 0',
      )
    }
    this.draftUpdates = new LocalDraftUpdates(this.db)
    this.organise = new LocalOrganise(this)
    this.organise.rebuild()
    this.#splitLegacyBodies()
  }

  #splitLegacyBodies() {
    const marker = 'body_text_split'
    if (this.db.prepare('SELECT 1 FROM meta WHERE key = ?').get(marker)) return
    const next = this.db.prepare(
      `SELECT rowid AS cursor, id, CASE WHEN body_text IS NULL THEN data END AS legacy
       FROM message WHERE rowid > ? ORDER BY rowid LIMIT 1`,
    )
    const save = this.db.prepare(
      'UPDATE message SET data = ?, body_text = ? WHERE id = ? AND body_text IS NULL',
    )
    let cursor = 0
    const log = mainLog.with({ runId: newRunId() })
    log.log('debug', 'desktop.operation.started', { stage: 'replica-migration' })
    const step = () => {
      if (!this.db.isOpen) return
      try {
        for (let i = 0; i < 64; i++) {
          const row = next.get(cursor) as
            | { cursor: number; id: string; legacy: string | null }
            | undefined
          if (!row) {
            this.db.prepare("INSERT OR IGNORE INTO meta VALUES (?, '1')").run(marker)
            log.log('debug', 'desktop.operation.finished', { stage: 'replica-migration' })
            return
          }
          cursor = row.cursor
          if (row.legacy !== null) {
            const { body, data } = splitMessage(JSON.parse(row.legacy))
            save.run(data, body, row.id)
            break // Yield after each body to keep other Electron work responsive.
          }
        }
      } catch (err) {
        // Keep the legacy read path available and retry after the next start.
        log.log('error', 'desktop.operation.failed', { stage: 'replica-migration', err })
        return
      }
      setImmediate(step).unref()
    }
    setImmediate(step).unref()
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

  clear({ keepNotificationHistory = false } = {}): void {
    if (!keepNotificationHistory) this.db.exec('DELETE FROM notified_message')
    this.db.exec('DELETE FROM organise_thread')
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
      try {
        this.db.exec('ROLLBACK')
      } catch (rollback) {
        operationFailure('replica-rollback', rollback)
      }
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
        const { body, data } = splitMessage(m)
        this.db
          .prepare(
            'INSERT OR REPLACE INTO message (id, thread_id, sent_at, data, body_text) VALUES (?, ?, ?, ?, ?)',
          )
          .run(m.id, m.threadId, m.sentAt, data, body)
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

  apply(changes: SyncChange[]): Map<string, string> {
    const arrivals = new Map<string, string>()
    const previous = this.db.prepare('SELECT last_message_at FROM thread WHERE id = ?')
    for (const change of changes) {
      if (change.entity === 'thread') {
        if (change.op === 'upsert' && change.data.inInbox && !change.data.bucket) {
          const old = previous.get(change.id)
          if (!old || Number(old.last_message_at) < change.data.lastMessageAt)
            arrivals.set(change.id, change.data.accountId)
        } else arrivals.delete(change.id)
      }
      if (change.op === 'upsert') this.put(change.entity, change.data)
      else this.remove(change.entity, change.id)
    }
    return arrivals
  }

  triageCounts(accountId: string | null): TriageCounts {
    const row = this.db
      .prepare(`
        SELECT COUNT(*) AS total, COUNT(*) FILTER (WHERE ${RECENT_DELIVERY}) AS recent
        FROM thread WHERE ${UNTRIAGED_INBOX} AND (:account IS NULL OR account_id = :account)
      `)
      .get({ ...triageWindow(), account: accountId })
    const recent = Number(row?.recent)
    return { recent, older: Number(row?.total) - recent }
  }

  triageAccount(
    accountId: string | null,
    pending: ReadonlyMap<string, string> | undefined,
    scope: 'recent' | 'older' | 'account',
  ): string | undefined {
    const window = scope === 'account' ? {} : triageWindow()
    const ageFilter = {
      account: '',
      recent: ` AND ${RECENT_DELIVERY}`,
      older: ` AND NOT COALESCE(${RECENT_DELIVERY}, 0)`,
    }[scope]
    const eligible = UNTRIAGED_INBOX + ageFilter
    if (pending) {
      const find = this.db.prepare(`SELECT 1 FROM thread WHERE id = :id AND ${eligible}`)
      for (const [id, account] of pending) if (find.get({ ...window, id })) return account
      return undefined
    }
    const row = this.db
      .prepare(`
        SELECT account_id FROM thread WHERE ${eligible}
          AND (:account IS NULL OR account_id = :account)
        ORDER BY last_message_at DESC LIMIT 1
      `)
      .get({ ...window, account: accountId })
    return typeof row?.account_id === 'string' ? row.account_id : undefined
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

  threads(query: ThreadQuery): DesktopThreadSummary[] {
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
      case 'snoozed':
        where.push("json_extract(data, '$.snoozedUntil') IS NOT NULL")
        break
      case 'trash':
        hasLabel('TRASH')
        break
      case 'sent':
        hasLabel('SENT')
        break
      case 'drafts':
        hasLabel('DRAFT')
        break
      case 'bucket':
        where.push("json_extract(data, '$.bucket.bucket') = ?")
        params.push(query.view.bucket)
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
        `SELECT ${THREAD_LIST_COLUMNS} FROM effective_thread ${where.length ? `WHERE ${where.join(' AND ')}` : ''}
         ORDER BY last_message_at DESC LIMIT ?`,
      )
      .all(...params, query.limit ?? 5000) as ThreadListRow[]
    return rows.map(readThreadListRow)
  }

  inboxFilterMessageIds(id: string): string[] {
    return this.db
      .prepare(`
        SELECT m.id FROM message m JOIN thread t ON t.id = m.thread_id
        WHERE t.id = ?
          AND EXISTS (SELECT 1 FROM json_each(m.data, '$.labelIds') WHERE value = t.account_id || ':INBOX')
          AND NOT EXISTS (SELECT 1 FROM json_each(m.data, '$.labelIds')
            WHERE value IN (t.account_id || ':SENT', t.account_id || ':DRAFT',
              t.account_id || ':SPAM', t.account_id || ':TRASH'))
      `)
      .all(id)
      .map(({ id }) => String(id))
      .sort()
  }

  thread(id: string): ThreadWithMessages | null {
    const base = this.baseThread(id)
    if (!base) return null
    this.organise.messages(base.thread, base.messages)
    const recent = base.messages.length - RECENT_THREAD_BODIES
    for (const [index, message] of base.messages.entries()) {
      if (index >= recent || message.unread) message.bodyText = this.messageText(message.id)
    }
    return base
  }

  baseThread(id: string): ThreadWithMessages | null {
    const row = this.db.prepare('SELECT data FROM thread WHERE id = ?').get(id) as
      | { data: string }
      | undefined
    if (!row) return null
    const messages = (
      this.db
        .prepare(
          `SELECT CASE WHEN body_text IS NULL THEN json_remove(data, '$.bodyText') ELSE data END AS data
           FROM message WHERE thread_id = ? ORDER BY sent_at, id`,
        )
        .all(id) as { data: string }[]
    ).map(
      (r): ReplicaThreadMessage => ({ bodyRevision: '', ...JSON.parse(r.data), bodyText: null }),
    )
    const drafts = (
      this.db
        .prepare('SELECT data FROM draft WHERE thread_id = ? ORDER BY updated_at DESC')
        .all(id) as { data: string }[]
    ).map((r) => JSON.parse(r.data) as Draft)
    return { thread: JSON.parse(row.data), messages, drafts }
  }

  summaries(ids: string[]): DesktopThreadSummary[] {
    const get = this.db.prepare(`SELECT ${THREAD_LIST_COLUMNS} FROM effective_thread WHERE id = ?`)
    return ids.slice(0, 100).flatMap((id) => {
      const row = get.get(id) as ThreadListRow | undefined
      return row ? [readThreadListRow(row)] : []
    })
  }

  counts(accountId: string | null): Counts {
    const row = this.db
      .prepare(
        `SELECT
           sum(in_inbox) AS inbox,
           sum(CASE WHEN in_inbox = 1 AND unread_count > 0 THEN 1 ELSE 0 END) AS inbox_unread,
           sum(starred) AS starred
         FROM effective_thread WHERE (?1 IS NULL OR account_id = ?1)`,
      )
      .get(accountId) as {
      inbox: number | null
      inbox_unread: number | null
      starred: number | null
    }
    const drafts = this.db
      .prepare(
        `SELECT count(*) AS n FROM effective_thread WHERE (?1 IS NULL OR account_id = ?1)
         AND EXISTS (SELECT 1 FROM json_each(label_ids) WHERE value LIKE '%:DRAFT')`,
      )
      .get(accountId) as { n: number }
    const buckets = this.db
      .prepare(`
      SELECT json_extract(data, '$.bucket.bucket') AS bucket, count(*) AS n
      FROM effective_thread
      WHERE (?1 IS NULL OR account_id = ?1) AND json_extract(data, '$.bucket.bucket') IS NOT NULL
      GROUP BY bucket
    `)
      .all(accountId) as { bucket: Bucket; n: number }[]
    const filtered = this.db
      .prepare(`
      SELECT l.id, (SELECT count(*) FROM effective_thread t
        WHERE t.account_id = l.account_id AND l.id IN (SELECT value FROM json_each(t.label_ids))) AS n
      FROM label l WHERE (?1 IS NULL OR l.account_id = ?1) AND json_extract(l.data, '$.managed') = 'filtered'
    `)
      .all(accountId) as { id: string; n: number }[]
    return {
      ...(filtered.length
        ? { filteredByLabel: Object.fromEntries(filtered.map(({ id, n }) => [id, n])) }
        : {}),
      buckets: Object.fromEntries(buckets.map(({ bucket, n }) => [bucket, n])),
      inbox: row.inbox ?? 0,
      inboxUnread: row.inbox_unread ?? 0,
      starred: row.starred ?? 0,
      drafts: drafts.n,
    }
  }

  filter(text: string, accountId: string | null): DesktopThreadSummary[] {
    const words = text.toLowerCase().split(/\s+/).filter(Boolean)
    if (words.length === 0) return []
    const rows = this.db
      .prepare(
        `SELECT ${THREAD_LIST_COLUMNS} FROM effective_thread WHERE (?1 IS NULL OR account_id = ?1)
         ${words.map(() => 'AND haystack LIKE ?').join(' ')}
         ORDER BY last_message_at DESC LIMIT 200`,
      )
      .all(accountId, ...words.map((w) => `%${w.replace(/[%_]/g, '')}%`)) as ThreadListRow[]
    return rows.map(readThreadListRow)
  }

  messageText(messageId: string): string | null {
    const row = this.db
      .prepare(
        'SELECT CAST(body_text AS BLOB) AS body, CASE WHEN body_text IS NULL THEN data END AS legacy FROM message WHERE id = ?',
      )
      .get(messageId) as { body: Uint8Array | null; legacy: string | null } | undefined
    if (row?.body) return Buffer.from(row.body).toString('utf8')
    return typeof row?.legacy === 'string'
      ? (JSON.parse(row.legacy) as MessageDetail).bodyText
      : null
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
