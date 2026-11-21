import type {
  AccountSummary,
  Address,
  AttachmentSummary,
  Label,
  MessageDetail,
  SearchHit,
  ThreadDetail,
  ThreadList,
  ThreadSummary,
} from '@amc/protocol'
import type { Db } from '../db/database.ts'

interface ThreadRow {
  id: string
  account_id: string
  subject: string
  snippet: string
  participants: string
  message_count: number
  unread_count: number
  starred: number
  in_inbox: number
  has_attachments: number
  label_ids: string
  last_message_at: number
  snoozed_until: number | null
  muted: number
}

interface MessageRow {
  id: string
  thread_id: string
  account_id: string
  rfc_message_id: string | null
  in_reply_to: string | null
  from_json: string
  to_json: string
  cc_json: string
  bcc_json: string
  reply_to_json: string
  subject: string
  snippet: string
  body_text: string
  body_search_truncated: number
  html_blob: string | null
  sent_at: number
  unread: number
  starred: number
  label_ids: string
  list_unsubscribe: string | null
}

interface AttachmentRow {
  id: string
  filename: string
  mime_type: string
  size: number
  inline: number
  content_id: string | null
}

function parseCursor(cursor: string | null): [number | null, string | null] {
  if (!cursor) return [null, null]
  const at = cursor.indexOf(':')
  return [Number(cursor.slice(0, at)), cursor.slice(at + 1)]
}

function toThread(row: ThreadRow): ThreadSummary {
  return {
    id: row.id,
    accountId: row.account_id,
    subject: row.subject,
    snippet: row.snippet,
    participants: JSON.parse(row.participants) as Address[],
    messageCount: row.message_count,
    unreadCount: row.unread_count,
    starred: row.starred === 1,
    inInbox: row.in_inbox === 1,
    hasAttachments: row.has_attachments === 1,
    labelIds: JSON.parse(row.label_ids) as string[],
    lastMessageAt: row.last_message_at,
    snoozedUntil: row.snoozed_until,
    muted: row.muted === 1,
  }
}

export interface ThreadQuery {
  accountId?: string
  /** A Label id such as `<account>:INBOX`; ignored when `inbox` is set. */
  labelId?: string
  /** Only Threads in the Inbox (across Accounts unless accountId is set). */
  inbox?: boolean
  unread?: boolean
  /** Return Threads whose last message is older than this (epoch ms), for paging. */
  before?: number
  limit?: number
}

/** The read side of the mail store. */
export class MailQueries {
  readonly db: Db

  readonly #inbox: string
  readonly #threadColumns: string

  constructor(db: Db, snoozeEnabled = false) {
    this.db = db
    // Old Gmail summaries may have suppressed Inbox membership while Snooze was enabled.
    this.#inbox = snoozeEnabled
      ? '(t.in_inbox AND t.snoozed_until IS NULL)'
      : `CASE WHEN t.in_inbox = 0 AND t.snoozed_until IS NOT NULL AND t.muted = 0 THEN EXISTS (
          SELECT 1 FROM message m WHERE m.thread_id = t.id
            AND t.account_id || ':INBOX' IN (SELECT value FROM json_each(m.label_ids))
            AND NOT EXISTS (
              SELECT 1 FROM json_each(m.label_ids)
              WHERE value IN (t.account_id || ':TRASH', t.account_id || ':SPAM')
            )
        ) ELSE t.in_inbox END`
    this.#threadColumns = `t.id, t.account_id, t.subject, t.snippet, t.participants, t.message_count,
      t.unread_count, t.starred, ${this.#inbox} AS in_inbox, t.has_attachments, t.label_ids,
      t.last_message_at, ${snoozeEnabled ? 't.snoozed_until' : 'NULL'} AS snoozed_until, t.muted`
  }

  accounts(): AccountSummary[] {
    const rows = this.db
      .prepare(
        `SELECT a.id, a.kind, a.address, a.display_name, a.status, a.last_sync_at, a.last_error, a.backfill, a.cursor,
                (SELECT count(*) FROM message m WHERE m.account_id = a.id) AS messages
         FROM account a ORDER BY a.created_at`,
      )
      .all() as {
      id: string
      kind: 'gmail' | 'imap'
      address: string
      display_name: string | null
      status: AccountSummary['status']
      last_sync_at: number | null
      last_error: string | null
      backfill: string
      cursor: string
      messages: number
    }[]
    return rows.map((r) => {
      const backfill = JSON.parse(r.backfill) as {
        phase?: 'recent' | 'all' | 'done'
        fetched?: number
        estimatedTotal?: number
      }
      const { imapMoves } =
        r.kind === 'imap' ? (JSON.parse(r.cursor) as { imapMoves?: boolean }) : {}
      return {
        ...(imapMoves !== undefined ? { imapMoves } : {}),
        id: r.id,
        kind: r.kind,
        address: r.address,
        displayName: r.display_name,
        status: r.status,
        lastSyncAt: r.last_sync_at,
        lastError: r.last_error,
        messageCount: r.messages,
        backfill: {
          phase: backfill.phase ?? null,
          fetched: backfill.fetched ?? 0,
          estimatedTotal: backfill.estimatedTotal ?? null,
        },
      }
    })
  }

  labels(accountId?: string): Label[] {
    const rows = this.db
      .prepare(
        `SELECT id, account_id, provider_id, name, kind, color FROM label
         WHERE (?1 IS NULL OR account_id = ?1) ORDER BY kind, name COLLATE NOCASE`,
      )
      .all(accountId ?? null) as {
      id: string
      account_id: string
      provider_id: string
      name: string
      kind: 'system' | 'user'
      color: string | null
    }[]
    return rows.map((r) => ({
      id: r.id,
      accountId: r.account_id,
      providerId: r.provider_id,
      name: r.name,
      kind: r.kind,
      color: r.color,
    }))
  }

  threads(query: ThreadQuery = {}): ThreadList {
    const limit = Math.min(Math.max(query.limit ?? 50, 1), 500)
    const where: string[] = []
    const params: (string | number)[] = []
    if (query.accountId) {
      where.push('t.account_id = ?')
      params.push(query.accountId)
    }
    if (query.inbox) {
      where.push(`(${this.#inbox}) = 1`)
    } else if (query.labelId) {
      where.push('EXISTS (SELECT 1 FROM json_each(t.label_ids) WHERE value = ?)')
      params.push(query.labelId)
    }
    if (query.unread) where.push('t.unread_count > 0')
    if (query.before !== undefined) {
      where.push('t.last_message_at < ?')
      params.push(query.before)
    }
    const rows = this.db
      .prepare(
        `SELECT ${this.#threadColumns} FROM thread t
         ${where.length ? `WHERE ${where.join(' AND ')}` : ''}
         ORDER BY t.last_message_at DESC LIMIT ?`,
      )
      .all(...params, limit + 1) as unknown as ThreadRow[]
    const page = rows.slice(0, limit).map(toThread)
    const last = page[page.length - 1]
    return { threads: page, nextBefore: rows.length > limit && last ? last.lastMessageAt : null }
  }

  thread(id: string): ThreadDetail | null {
    const row = this.db
      .prepare(`SELECT ${this.#threadColumns} FROM thread t WHERE t.id = ?`)
      .get(id) as ThreadRow | undefined
    if (!row) return null
    return {
      ...toThread(row),
      messages: this.#messages('m.thread_id = ? ORDER BY m.sent_at ASC', [id]),
    }
  }

  threadSummary(id: string): ThreadSummary | null {
    const row = this.db
      .prepare(`SELECT ${this.#threadColumns} FROM thread t WHERE t.id = ?`)
      .get(id) as ThreadRow | undefined
    return row ? toThread(row) : null
  }

  message(id: string): MessageDetail | null {
    return this.#messages('m.id = ?', [id])[0] ?? null
  }

  account(id: string): AccountSummary | null {
    return this.accounts().find((a) => a.id === id) ?? null
  }

  label(id: string): Label | null {
    const row = this.db.prepare('SELECT account_id FROM label WHERE id = ?').get(id) as
      | { account_id: string }
      | undefined
    return row ? (this.labels(row.account_id).find((l) => l.id === id) ?? null) : null
  }

  /** Keyset pages of Threads, newest first, for replica snapshots. Cursor = "<lastMessageAt>:<id>". */
  threadPage(cursor: string | null, limit: number): { rows: ThreadSummary[]; next: string | null } {
    const [at, id] = parseCursor(cursor)
    const rows = this.db
      .prepare(
        `SELECT ${this.#threadColumns} FROM thread t
         WHERE (?1 IS NULL OR t.last_message_at < ?1 OR (t.last_message_at = ?1 AND t.id < ?2))
         ORDER BY t.last_message_at DESC, t.id DESC LIMIT ?3`,
      )
      .all(at, id, limit) as unknown as ThreadRow[]
    const last = rows.at(-1)
    return {
      rows: rows.map(toThread),
      next: rows.length === limit && last ? `${last.last_message_at}:${last.id}` : null,
    }
  }

  /** Keyset pages of messages, newest first, for replica snapshots. */
  messagePage(
    cursor: string | null,
    limit: number,
  ): { rows: MessageDetail[]; next: string | null } {
    const [at, id] = parseCursor(cursor)
    const rows = this.#messages(
      `(?1 IS NULL OR m.sent_at < ?1 OR (m.sent_at = ?1 AND m.id < ?2)) ORDER BY m.sent_at DESC, m.id DESC LIMIT ?3`,
      [at, id, limit],
    )
    const last = rows.at(-1)
    return { rows, next: rows.length === limit && last ? `${last.sentAt}:${last.id}` : null }
  }

  #messages(where: string, params: (string | number | null)[]): MessageDetail[] {
    const rows = this.db
      .prepare(
        `SELECT m.id, m.thread_id, m.account_id, m.rfc_message_id, m.in_reply_to, m.from_json, m.to_json,
                m.cc_json, m.bcc_json, m.reply_to_json, m.subject, m.snippet, m.body_text, m.html_blob,
                coalesce(length(m.body_text) > m.body_search_limit, 0) AS body_search_truncated,
                m.sent_at, m.unread, m.starred, m.label_ids, m.list_unsubscribe
         FROM message m WHERE ${where}`,
      )
      .all(...params) as unknown as MessageRow[]
    const attachments = this.db.prepare(
      'SELECT id, filename, mime_type, size, inline, content_id FROM attachment WHERE message_id = ? ORDER BY id',
    )
    return rows.map(
      (m): MessageDetail => ({
        id: m.id,
        threadId: m.thread_id,
        accountId: m.account_id,
        rfcMessageId: m.rfc_message_id,
        inReplyTo: m.in_reply_to,
        from: JSON.parse(m.from_json) as Address | null,
        to: JSON.parse(m.to_json) as Address[],
        cc: JSON.parse(m.cc_json) as Address[],
        bcc: JSON.parse(m.bcc_json) as Address[],
        replyTo: JSON.parse(m.reply_to_json) as Address[],
        subject: m.subject,
        snippet: m.snippet,
        bodyText: m.body_text,
        bodySearchTruncated: Boolean(m.body_search_truncated),
        hasHtml: m.html_blob !== null,
        sentAt: m.sent_at,
        unread: m.unread === 1,
        starred: m.starred === 1,
        labelIds: JSON.parse(m.label_ids) as string[],
        listUnsubscribe: m.list_unsubscribe,
        attachments: (attachments.all(m.id) as unknown as AttachmentRow[]).map(
          (a): AttachmentSummary => ({
            id: a.id,
            filename: a.filename,
            mimeType: a.mime_type,
            size: a.size,
            inline: a.inline === 1,
            contentId: a.content_id,
          }),
        ),
      }),
    )
  }

  messageHtmlBlob(messageId: string): string | null {
    const row = this.db.prepare('SELECT html_blob FROM message WHERE id = ?').get(messageId) as
      | { html_blob: string | null }
      | undefined
    return row?.html_blob ?? null
  }

  /** Full-text search over the entire history, best matches first, one hit per Thread. */
  search(text: string, options: { accountId?: string; limit?: number } = {}): SearchHit[] {
    const match = toFtsQuery(text)
    if (!match) return []
    const limit = Math.min(Math.max(options.limit ?? 30, 1), 200)
    const rows = this.db
      .prepare(
        `WITH hits AS (
           SELECT m.thread_id, bm25(message_fts, 10.0, 5.0, 1.0, 2.0) AS rank,
                  snippet(message_fts, 2, '«', '»', '…', 12) AS match_snippet
           FROM message_fts JOIN message m ON m.rowid = message_fts.rowid
           WHERE message_fts MATCH ? AND (? IS NULL OR m.account_id = ?)
           ORDER BY rank LIMIT 2000
         ), best AS (
           SELECT thread_id, min(rank) AS rank, match_snippet FROM hits GROUP BY thread_id
         )
         SELECT ${this.#threadColumns}, best.match_snippet
         FROM best JOIN thread t ON t.id = best.thread_id
         ORDER BY best.rank + (strftime('%s','now') * 1000 - t.last_message_at) / 3.15e12 ASC
         LIMIT ?`,
      )
      .all(
        match,
        options.accountId ?? null,
        options.accountId ?? null,
        limit,
      ) as unknown as (ThreadRow & {
      match_snippet: string
    })[]
    return rows.map((r) => ({ ...toThread(r), matchSnippet: r.match_snippet }))
  }
}

/**
 * Turns what a person types into a safe FTS5 query: every word must match (prefix match on the
 * last one), quoted so that FTS syntax characters in the input can't break the query.
 * Supports `from:`/`to:` style field filters on the people column.
 */
export function toFtsQuery(text: string): string | null {
  const tokens = text.match(/(\w+:)?"[^"]*"|\S+/g) ?? []
  const parts: string[] = []
  tokens.forEach((raw, index) => {
    const field = /^(from|to|cc|subject):/i.exec(raw)
    let value = field ? raw.slice(field[0].length) : raw
    value = value.replace(/^"|"$/g, '').replace(/"/g, '""').trim()
    if (!value) return
    const isLast = index === tokens.length - 1
    const term = `"${value}"${isLast && !field ? '*' : ''}`
    if (field) {
      const column = field[1]?.toLowerCase() === 'subject' ? 'subject' : 'people'
      parts.push(`${column} : ${term}`)
    } else {
      parts.push(term)
    }
  })
  return parts.length ? parts.join(' AND ') : null
}
