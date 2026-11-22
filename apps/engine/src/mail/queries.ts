import type {
  AccountSummary,
  Address,
  AttachmentSummary,
  Bucket,
  BucketConfidence,
  InboxSender,
  Label,
  MessageDetail,
  SearchHit,
  ThreadDetail,
  ThreadList,
  ThreadSummary,
} from '@amc/protocol'
import { RECENT_THREAD_BODIES } from '@amc/protocol'
import type { BlobStore } from '../blobs.ts'
import type { Db } from '../db/database.ts'
import { type BodyParts, readBodyParts, readTextBody } from './body-blobs.ts'
import { senderStatusSql } from './senders/index.ts'
import { latestInboxMessageSql } from './triage/input.ts'

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
  bucket: Bucket | null
  bucket_confidence: BucketConfidence | null
  bucket_reason: string
  bucket_set_by: string
  bucket_set_at: number
  inbox_sender: string | null
  owner_handled_message_id: string | null
}

type MessageWithBody<Body extends string | null> = Omit<MessageDetail, 'bodyText'> & {
  bodyText: Body
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
  body_text: Uint8Array | null
  body_parts: string | null
  body_search_truncated: number
  html_blob: string | null
  sent_at: number
  delivered_at: number | null
  unread: number
  starred: number
  label_ids: string
  list_unsubscribe: string | null
  screening_disposition: MessageDetail['screeningDisposition'] | null
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
    ...(row.inbox_sender ? { inboxSender: JSON.parse(row.inbox_sender) as InboxSender } : {}),
    ownerHandledMessageId: row.owner_handled_message_id,
    bucket: row.bucket
      ? {
          bucket: row.bucket,
          reason: row.bucket_reason,
          setBy: row.bucket_set_by,
          setAt: row.bucket_set_at,
          ...(row.bucket_confidence ? { confidence: row.bucket_confidence } : {}),
        }
      : null,
  }
}

export interface ThreadQuery {
  accountId?: string
  /** A Label id such as `<account>:INBOX`; ignored when `inbox` is set. */
  labelId?: string
  /** Only Threads in the Inbox (across Accounts unless accountId is set). */
  inbox?: boolean
  unread?: boolean
  untriaged?: boolean
  triageInput?: boolean
  deliveredSince?: number
  /** Return Threads whose last message is older than this (epoch ms), for paging. */
  before?: number
  limit?: number
}

/** The read side of the mail store. */
export class MailQueries {
  readonly db: Db

  readonly #threadColumns: string
  readonly #readAgentBody: ReturnType<Db['prepare']>

  readonly #blobs?: BlobStore

  constructor(db: Db, snoozeEnabled = false, blobs?: BlobStore) {
    this.#blobs = blobs
    this.db = db
    this.#readAgentBody = db.prepare(
      'SELECT substr(CAST(body_text AS BLOB), 1, ?) AS body FROM message WHERE id = ?',
    )
    this.#threadColumns = `t.id, t.account_id, t.subject, t.snippet, t.participants, t.message_count,
      t.unread_count, t.starred, t.in_inbox, t.has_attachments, t.label_ids,
      t.last_message_at, ${snoozeEnabled ? 't.snoozed_until' : 'NULL'} AS snoozed_until, t.muted,
      t.bucket, t.bucket_reason, t.bucket_set_by, t.bucket_set_at,
      CASE WHEN t.in_inbox = 1 AND t.bucket_confidence IS NOT NULL THEN
        CASE WHEN t.bucket_input_message_id = ${latestInboxMessageSql} THEN t.bucket_confidence END
      END AS bucket_confidence,
      (SELECT h.message_id FROM owner_handled h WHERE h.thread_id = t.id) AS owner_handled_message_id,
      CASE WHEN t.in_inbox = 1 THEN (
        SELECT json_object('accountId', i.account_id, 'address', i.address, 'messageId', m.id,
          'status', ${senderStatusSql}, 'revision', coalesce(r.revision, 0))
        FROM message m JOIN sender_index i ON i.message_id = m.id
        LEFT JOIN sender_rule r ON r.account_id = i.account_id AND r.address = i.address
        WHERE m.thread_id = t.id AND i.in_inbox = 1
          AND m.account_id || ':INBOX' IN (SELECT value FROM json_each(m.label_ids))
        ORDER BY m.sent_at DESC, m.id DESC LIMIT 1
      ) END AS inbox_sender`
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
        `SELECT l.id, l.account_id, l.provider_id, l.name, l.kind, l.color,
           EXISTS (SELECT 1 FROM filtered_destination d WHERE d.account_id = l.account_id
             AND d.provider_id = l.provider_id) AS filtered
         FROM label l WHERE (?1 IS NULL OR l.account_id = ?1) ORDER BY l.kind, l.name COLLATE NOCASE`,
      )
      .all(accountId ?? null) as {
      id: string
      account_id: string
      provider_id: string
      name: string
      kind: 'system' | 'user'
      color: string | null
      filtered: number
    }[]
    return rows.map((r) => ({
      id: r.id,
      accountId: r.account_id,
      providerId: r.provider_id,
      name: r.name,
      kind: r.kind,
      color: r.color,
      ...(r.filtered ? { managed: 'filtered' as const } : {}),
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
      where.push('t.in_inbox = 1')
    } else if (query.labelId) {
      where.push('EXISTS (SELECT 1 FROM json_each(t.label_ids) WHERE value = ?)')
      params.push(query.labelId)
    }
    if (query.untriaged) where.push('t.bucket IS NULL')
    if (query.triageInput)
      where.push(`
      ${latestInboxMessageSql} IS NOT NULL AND t.filter_suggestion_message_id IS NOT ${latestInboxMessageSql}
      AND NOT EXISTS (
        SELECT 1 FROM owner_handled h WHERE h.thread_id = t.id AND h.message_id = ${latestInboxMessageSql}
      )
    `)
    if (query.deliveredSince !== undefined) {
      where.push(`(
        SELECT MAX(m.delivered_at) FROM message m WHERE m.thread_id = t.id
      ) BETWEEN ? AND ?`)
      params.push(query.deliveredSince, Date.now())
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

  thread(id: string, deferBodies = false): ThreadDetail | null {
    const thread = this.threadSummary(id)
    if (!thread) return null
    return {
      ...thread,
      messages: this.#messages<string | null>(
        'm.thread_id = ?1 ORDER BY m.sent_at, m.id',
        [id],
        deferBodies
          ? `CASE WHEN m.unread = 1 OR m.id IN (
           SELECT id FROM message WHERE thread_id = ?1
           ORDER BY sent_at DESC, id DESC LIMIT ${RECENT_THREAD_BODIES}
         ) THEN m.body_text END`
          : 'm.body_text',
      ),
    }
  }

  /** Agent reads preserve every message, with a text budget for the whole thread. */
  agentThread(
    id: string,
    messageLimit: number,
    threadLimit: number,
    excludeDrafts = false,
  ): (ThreadSummary & { messages: MessageDetail[] }) | null {
    const thread = this.threadSummary(id)
    if (!thread) return null
    const messages = this.#messages<null>(
      'm.thread_id = ? ORDER BY m.sent_at, m.id',
      [id],
      'NULL',
    ).filter((message) => !excludeDrafts || !message.labelIds.includes(`${thread.accountId}:DRAFT`))
    let remaining = threadLimit
    return {
      ...thread,
      ...(excludeDrafts
        ? {
            subject: messages[0]?.subject ?? '',
            snippet: messages.at(-1)?.snippet ?? '',
          }
        : {}),
      messages: messages
        .reverse()
        .map((message) => {
          const { bodyText, length } = this.#agentBody(
            message.id,
            Math.min(messageLimit, remaining),
          )
          remaining -= length
          return { ...message, bodyText }
        })
        .reverse(),
    }
  }

  agentMessage(id: string, limit: number): MessageDetail | null {
    const [message] = this.#messages<null>('m.id = ?', [id], 'NULL')
    return message ? { ...message, bodyText: this.#agentBody(id, limit).bodyText } : null
  }

  #agentBody(id: string, limit: number): { bodyText: string; length: number } {
    // Read enough UTF-8 bytes for the allowed text and one extra character to detect truncation.
    const row = this.#readAgentBody.get(4 * (limit + 1), id) as { body: Uint8Array | null }
    const body = row.body ? Buffer.from(row.body).toString('utf8') : ''
    return {
      bodyText: body.length > limit ? `${body.slice(0, limit)}\n[…truncated]` : body,
      length: Math.min(body.length, limit),
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

  #messages<Body extends string | null = string>(
    where: string,
    params: (string | number | null)[],
    body = 'm.body_text',
  ): MessageWithBody<Body>[] {
    const rows = this.db
      .prepare(
        `SELECT m.id, m.thread_id, m.account_id, m.rfc_message_id, m.in_reply_to, m.from_json, m.to_json,
                m.cc_json, m.bcc_json, m.reply_to_json, m.subject, m.snippet, CAST(${body} AS BLOB) AS body_text, m.body_parts, m.html_blob,
                CASE WHEN m.body_search_limit IS NOT NULL THEN length(m.body_text) > m.body_search_limit ELSE 0 END AS body_search_truncated,
                m.sent_at, m.delivered_at, m.unread, m.starred, m.label_ids, m.list_unsubscribe,
                CASE WHEN EXISTS (
                  SELECT 1 FROM screened_destination d WHERE d.account_id = m.account_id
                    AND m.account_id || ':' || d.provider_id IN (SELECT value FROM json_each(m.label_ids))
                    AND m.account_id || ':INBOX' NOT IN (SELECT value FROM json_each(m.label_ids))
                ) THEN 'screened' ELSE (
                  SELECT CASE WHEN w.status = 'pending' THEN 'pending'
                              WHEN w.status IN ('partial', 'failed') THEN 'failed'
                              WHEN w.status = 'applied' THEN 'returned' END
                  FROM sender_index i JOIN sender_rule r USING(account_id, address)
                  JOIN screening_work w ON w.action_id = r.action_id
                    AND w.identity = coalesce(m.imap_fingerprint, i.message_id)
                  WHERE i.message_id = m.id AND i.in_inbox = 1 AND r.decision = 'block'
                ) END AS screening_disposition
         FROM message m WHERE ${where}`,
      )
      .all(...params) as unknown as MessageRow[]
    const attachments = this.db.prepare(
      'SELECT id, filename, mime_type, size, inline, content_id FROM attachment WHERE message_id = ? ORDER BY id',
    )
    return rows.map((m): MessageWithBody<Body> => {
      const bodyParts = m.body_parts ? (JSON.parse(m.body_parts) as BodyParts) : null
      const bodyText =
        m.body_text === null
          ? null
          : ((bodyParts && this.#blobs ? readTextBody(this.#blobs, bodyParts) : undefined) ??
            Buffer.from(m.body_text).toString('utf8'))
      return {
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
        bodyText: bodyText as Body,
        bodySearchTruncated: Boolean(bodyParts?.searchTruncated || m.body_search_truncated),
        hasHtml: m.html_blob !== null || Boolean(bodyParts?.html),
        sentAt: m.sent_at,
        ...(m.delivered_at === null ? {} : { deliveredAt: m.delivered_at }),
        ...(m.screening_disposition ? { screeningDisposition: m.screening_disposition } : {}),
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
      }
    })
  }

  messageHtml(messageId: string, blobs: BlobStore): string | null {
    const row = this.db
      .prepare('SELECT html_blob, body_parts FROM message WHERE id = ?')
      .get(messageId) as { html_blob: string | null; body_parts: string | null } | undefined
    if (row?.html_blob) return blobs.get(row.html_blob)?.toString('utf8') ?? null
    const parts = row?.body_parts ? (JSON.parse(row.body_parts) as BodyParts).html : undefined
    return parts ? (readBodyParts(blobs, parts) ?? null) : null
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
