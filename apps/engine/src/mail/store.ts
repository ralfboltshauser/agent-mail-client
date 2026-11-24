import { EventEmitter } from 'node:events'
import {
  type Address,
  applyLabelPatch,
  type BucketInput,
  type BucketStorageKey,
  type LabelPatch,
} from '@amc/protocol'
import type { BlobStore } from '../blobs.ts'
import { type Db, transaction } from '../db/database.ts'
import type { BodyParts } from './body-blobs.ts'
import { observeSender } from './senders/index.ts'

/** A message as any provider connector hands it to the store. */
export interface IncomingMessage {
  providerId: string
  providerThreadId: string
  rfcMessageId: string | null
  inReplyTo: string | null
  references: string | null
  from: Address | null
  to: Address[]
  cc: Address[]
  bcc: Address[]
  replyTo: Address[]
  subject: string
  snippet: string
  bodyText: string
  bodySearchLimit?: number
  bodyParts?: BodyParts | null
  bodyHtmlBlob?: string | null
  bodyHtml: string | null
  sentAt: number
  deliveredAt?: number
  size: number
  /** Provider label ids, e.g. Gmail's INBOX, UNREAD, Label_123. */
  labels: string[]
  providerHistoryId?: string
  providerDeliveryHistoryId?: string | null | undefined
  /** Providers with separate flags can supply them without adding synthetic Labels. */
  unread?: boolean
  starred?: boolean
  listUnsubscribe: string | null
  listId?: string | null
  attachments: IncomingAttachment[]
}

export interface IncomingAttachment {
  providerAttachmentId: string | null
  filename: string
  mimeType: string
  size: number
  contentId: string | null
  inline: boolean
  /** Small attachments arrive inline with the message; larger ones are fetched on first open. */
  data?: Uint8Array
  blob?: string
}

export interface IncomingLabel {
  providerId: string
  name: string
  kind: 'system' | 'user'
  color: string | null
}

export type Entity = 'account' | 'label' | 'thread' | 'message' | 'draft'

export const labelId = (accountId: string, providerLabel: string) => `${accountId}:${providerLabel}`
export const threadId = (accountId: string, providerThreadId: string) =>
  `${accountId}:${providerThreadId}`
export const messageId = (accountId: string, providerId: string) => `${accountId}:${providerId}`

export function canonicalListId(header: string | null | undefined) {
  const value = header?.trim() ?? ''
  if (value.length > 1024) return null
  const id = /^(?:[^<>]*<([^<>\s]+)>|([^<>\s]+))$/.exec(value)
  const label = id?.[1] ?? id?.[2] ?? ''
  return /^[a-z0-9._-]{1,255}$/i.test(label) ? label.toLowerCase() : null
}

function isOlderProviderRead(incoming: string | undefined, stored: string | null): boolean {
  return stored !== null && (incoming === undefined || BigInt(incoming) < BigInt(stored))
}

/**
 * The write side of the mail store. Every mutation records a change-log entry and stamps the
 * entity's modseq, which is what Clients sync from (plan §5). Callers group work in
 * transactions; each public method is atomic on its own.
 */
export class MailStore extends EventEmitter<{ change: [] }> {
  readonly db: Db
  readonly blobs: BlobStore
  readonly #now: () => number

  constructor(db: Db, blobs: BlobStore, { now = Date.now }: { now?: () => number } = {}) {
    super()
    this.setMaxListeners(100)
    this.db = db
    this.blobs = blobs
    this.#now = now
  }

  recordChange(entity: Entity | 'bucket_catalog', id: string, op: 'upsert' | 'delete'): number {
    const { lastInsertRowid } = this.db
      .prepare('INSERT INTO change_log (entity, entity_id, op, at) VALUES (?, ?, ?, ?)')
      .run(entity, id, op, this.#now())
    const modseq = Number(lastInsertRowid)
    this.emit('change')
    if (op === 'upsert' && entity !== 'bucket_catalog') {
      this.db.prepare(`UPDATE ${entity} SET modseq = ? WHERE id = ?`).run(modseq, id)
    }
    return modseq
  }

  setBucket(
    { threadId, bucket, reason }: Omit<BucketInput, 'bucket'> & { bucket: BucketStorageKey | null },
    setBy: string,
    onlyUntriaged = false,
  ) {
    return transaction(this.db, () => {
      const updated = this.db
        .prepare(`
        UPDATE thread SET bucket = ?, bucket_reason = ?, bucket_set_by = ?, bucket_set_at = ?
        WHERE id = ? AND (? = 0 OR (bucket IS NULL AND in_inbox = 1))
      `)
        .run(
          bucket,
          bucket ? reason : null,
          bucket ? setBy : null,
          bucket ? this.#now() : null,
          threadId,
          Number(onlyUntriaged),
        )
      if (!updated.changes) return false
      this.recordChange('thread', threadId, 'upsert')
      return true
    })
  }

  /** Replaces an Account's Labels with the provider's current set. */
  syncLabels(accountId: string, labels: IncomingLabel[]): void {
    transaction(this.db, () => {
      const existing = new Map(
        (
          this.db
            .prepare('SELECT id, name, kind, color FROM label WHERE account_id = ?')
            .all(accountId) as { id: string; name: string; kind: string; color: string | null }[]
        ).map((row) => [row.id, row]),
      )
      for (const label of labels) {
        const id = labelId(accountId, label.providerId)
        const old = existing.get(id)
        existing.delete(id)
        if (
          old &&
          old.name === label.name &&
          old.kind === label.kind &&
          old.color === label.color
        ) {
          continue
        }
        this.putLabel(accountId, label)
      }
      for (const id of existing.keys()) {
        this.db.prepare('DELETE FROM label WHERE id = ?').run(id)
        this.recordChange('label', id, 'delete')
      }
    })
  }

  hasMessage(accountId: string, providerId: string): boolean {
    return (
      this.db
        .prepare('SELECT 1 FROM message WHERE id = ?')
        .get(messageId(accountId, providerId)) !== undefined
    )
  }

  putLabel(accountId: string, label: IncomingLabel): void {
    const id = labelId(accountId, label.providerId)
    this.db
      .prepare(
        `INSERT INTO label (id, account_id, provider_id, name, kind, color) VALUES (?, ?, ?, ?, ?, ?)
       ON CONFLICT (id) DO UPDATE SET name = excluded.name, kind = excluded.kind, color = excluded.color`,
      )
      .run(id, accountId, label.providerId, label.name, label.kind, label.color)
    this.recordChange('label', id, 'upsert')
  }

  providerLabels(accountId: string, labels: string[]): string[] {
    return labels.map((id) => labelId(accountId, id))
  }

  /** Inserts or fully replaces one message, then refreshes its Thread. */
  putMessage(accountId: string, ownAddresses: readonly string[], msg: IncomingMessage): void {
    transaction(this.db, () => this.#putMessage(accountId, ownAddresses, msg))
  }

  /** Stores many messages in one transaction (backfill pages). */
  putMessages(accountId: string, ownAddresses: readonly string[], msgs: IncomingMessage[]): void {
    if (msgs.length === 0) return
    transaction(this.db, () => {
      for (const msg of msgs) this.#putMessage(accountId, ownAddresses, msg)
    })
  }

  #putMessage(accountId: string, ownAddresses: readonly string[], msg: IncomingMessage): void {
    const tid = threadId(accountId, msg.providerThreadId)
    const mid = messageId(accountId, msg.providerId)
    const previous = this.db
      .prepare(
        'SELECT thread_id, provider_label_ids, provider_history_id FROM message WHERE id = ?',
      )
      .get(mid) as
      | { thread_id: string; provider_label_ids: string; provider_history_id: string | null }
      | undefined
    const stale =
      previous && isOlderProviderRead(msg.providerHistoryId, previous.provider_history_id)
    const providerLabels = stale
      ? (JSON.parse(previous.provider_label_ids) as string[])
      : this.providerLabels(accountId, msg.labels)
    const labels = this.projectLabels(mid, providerLabels)
    const htmlBlob = msg.bodyHtmlBlob ?? (msg.bodyHtml ? this.blobs.put(msg.bodyHtml) : null)

    this.db
      .prepare(
        `INSERT INTO thread (id, account_id, provider_thread_id) VALUES (?, ?, ?)
         ON CONFLICT (id) DO NOTHING`,
      )
      .run(tid, accountId, msg.providerThreadId)

    this.db
      .prepare(
        `INSERT INTO message (
           id, account_id, thread_id, provider_id, rfc_message_id, in_reply_to, refs,
           from_json, to_json, cc_json, bcc_json, reply_to_json, subject, snippet, body_text, body_search_limit,
           body_parts, html_blob, sent_at, size, label_ids, unread, starred, list_unsubscribe, provider_label_ids,
           first_seen_at, provider_history_id, provider_delivery_history_id, delivered_at, list_id
         ) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)
         ON CONFLICT (id) DO UPDATE SET
           thread_id = excluded.thread_id, rfc_message_id = excluded.rfc_message_id,
           in_reply_to = excluded.in_reply_to, refs = excluded.refs, from_json = excluded.from_json,
           to_json = excluded.to_json, cc_json = excluded.cc_json, bcc_json = excluded.bcc_json,
           reply_to_json = excluded.reply_to_json, subject = excluded.subject,
           snippet = excluded.snippet, body_text = excluded.body_text,
           body_search_limit = excluded.body_search_limit, body_parts = excluded.body_parts, html_blob = excluded.html_blob,
           sent_at = excluded.sent_at, size = excluded.size, label_ids = excluded.label_ids,
           unread = excluded.unread, starred = excluded.starred,
           list_unsubscribe = excluded.list_unsubscribe, provider_label_ids = excluded.provider_label_ids,
           provider_history_id = excluded.provider_history_id,
           provider_delivery_history_id = COALESCE(message.provider_delivery_history_id, excluded.provider_delivery_history_id),
           delivered_at = COALESCE(excluded.delivered_at, message.delivered_at), list_id = excluded.list_id`,
      )
      .run(
        mid,
        accountId,
        tid,
        msg.providerId,
        msg.rfcMessageId,
        msg.inReplyTo,
        msg.references,
        JSON.stringify(msg.from),
        JSON.stringify(msg.to),
        JSON.stringify(msg.cc),
        JSON.stringify(msg.bcc),
        JSON.stringify(msg.replyTo),
        msg.subject,
        msg.snippet,
        msg.bodyText,
        msg.bodySearchLimit ?? null,
        msg.bodyParts ? JSON.stringify(msg.bodyParts) : null,
        htmlBlob,
        msg.sentAt,
        msg.size,
        JSON.stringify(labels),
        Number(msg.unread ?? labels.includes(labelId(accountId, 'UNREAD'))),
        Number(msg.starred ?? labels.includes(labelId(accountId, 'STARRED'))),
        msg.listUnsubscribe,
        JSON.stringify(providerLabels),
        this.#now(),
        stale ? previous.provider_history_id : (msg.providerHistoryId ?? null),
        msg.providerDeliveryHistoryId ?? null,
        msg.deliveredAt ?? null,
        canonicalListId(msg.listId),
      )

    observeSender(this, mid, providerLabels, ownAddresses)
    this.#putAttachments(mid, msg.attachments)
    if (!previous) this.#noteContacts(ownAddresses, msg)
    this.recordChange('message', mid, 'upsert')
    this.refreshThread(tid)
    if (previous && previous.thread_id !== tid) this.refreshThread(previous.thread_id)
  }

  #putAttachments(mid: string, attachments: IncomingAttachment[]): void {
    const known = new Map(
      (
        this.db
          .prepare(
            'SELECT id, provider_attachment, filename, blob FROM attachment WHERE message_id = ?',
          )
          .all(mid) as { id: string; filename: string; blob: string | null }[]
      ).map((a) => [a.id, a]),
    )
    this.db.prepare('DELETE FROM attachment WHERE message_id = ?').run(mid)
    const insert = this.db.prepare(
      `INSERT INTO attachment (id, message_id, provider_attachment, filename, mime_type, size, content_id, inline, blob)
       VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?)`,
    )
    attachments.forEach((a, index) => {
      const id = `${mid}:${index}`
      // Gmail attachment ids change between fetches; keep a fetched blob when the file is the same.
      const old = known.get(id)
      const blob =
        a.blob ??
        (a.data ? this.blobs.put(a.data) : old && old.filename === a.filename ? old.blob : null)
      insert.run(
        id,
        mid,
        a.providerAttachmentId,
        a.filename,
        a.mimeType,
        a.size,
        a.contentId,
        a.inline ? 1 : 0,
        blob,
      )
    })
    const names = attachments
      .filter((a) => !a.inline && a.filename)
      .map((a) => a.filename)
      .join(' ')
    this.db
      .prepare(
        'UPDATE message_fts SET attachments = ? WHERE rowid = (SELECT rowid FROM message WHERE id = ?)',
      )
      .run(names, mid)
  }

  #noteContacts(ownAddresses: readonly string[], msg: IncomingMessage): void {
    const own = new Set(ownAddresses.map((a) => a.toLowerCase()))
    const fromSelf = msg.from ? own.has(msg.from.address.toLowerCase()) : false
    const upsert = this.db.prepare(
      `INSERT INTO contact (address, name, last_seen_at, received_count, sent_count) VALUES (?, ?, ?, ?, ?)
       ON CONFLICT (address) DO UPDATE SET
         name = COALESCE(excluded.name, contact.name),
         last_seen_at = MAX(contact.last_seen_at, excluded.last_seen_at),
         received_count = contact.received_count + excluded.received_count,
         sent_count = contact.sent_count + excluded.sent_count`,
    )
    const people = fromSelf
      ? [...msg.to, ...msg.cc, ...msg.bcc].map((a) => ({ a, sent: 1, received: 0 }))
      : msg.from
        ? [{ a: msg.from, sent: 0, received: 1 }]
        : []
    for (const { a, sent, received } of people) {
      const address = a.address.toLowerCase()
      if (!address.includes('@') || own.has(address)) continue
      upsert.run(address, a.name || null, msg.sentAt, received, sent)
    }
  }

  /** Applies a label change reported by the provider (Gmail history labelsAdded/Removed). */
  setMessageLabels(
    accountId: string,
    providerId: string,
    labels: string[],
    historyId?: string,
  ): void {
    transaction(this.db, () => this.putProviderLabels(accountId, providerId, labels, historyId))
  }

  /** Stores a versioned Gmail snapshot inside the caller's transaction. */
  putProviderLabels(
    accountId: string,
    providerId: string,
    labels: string[],
    historyId?: string,
  ): { labels: string[]; historyId: string | undefined } {
    const mid = messageId(accountId, providerId)
    const stored = this.db
      .prepare(
        'SELECT thread_id, provider_label_ids, provider_history_id FROM message WHERE id = ?',
      )
      .get(mid) as
      | { thread_id: string; provider_label_ids: string; provider_history_id: string | null }
      | undefined
    if (stored && isOlderProviderRead(historyId, stored.provider_history_id)) {
      return {
        labels: JSON.parse(stored.provider_label_ids) as string[],
        historyId: stored.provider_history_id ?? undefined,
      }
    }
    const providerLabels = this.providerLabels(accountId, labels)
    if (stored) {
      this.db
        .prepare('UPDATE message SET provider_label_ids = ?, provider_history_id = ? WHERE id = ?')
        .run(JSON.stringify(providerLabels), historyId ?? null, mid)
      observeSender(this, mid, providerLabels)
      if (this.refreshMessageLabels(mid)) this.refreshThread(stored.thread_id)
    }
    return { labels: providerLabels, historyId }
  }

  private projectLabels(id: string, base: string[]): string[] {
    const pending = this.db
      .prepare(
        `SELECT p.patch FROM mutation_message p JOIN mutation m ON m.id = p.mutation_id
       WHERE p.message_id = ? AND m.status = 'pending'
         AND json_extract(m.request, '$.work') IS NOT 'screen' ORDER BY m.seq`,
      )
      .all(id) as { patch: string }[]
    return pending.reduce(
      (labels, row) => applyLabelPatch(labels, JSON.parse(row.patch) as LabelPatch),
      base,
    )
  }

  refreshMessageLabels(id: string): boolean {
    const row = this.db
      .prepare(`SELECT m.account_id, m.label_ids, m.provider_label_ids, m.unread, m.starred, a.kind
        FROM message m JOIN account a ON a.id = m.account_id WHERE m.id = ?`)
      .get(id) as
      | {
          account_id: string
          label_ids: string
          provider_label_ids: string | null
          unread: number
          starred: number
          kind: string
        }
      | undefined
    if (!row) return false
    const unreadId = labelId(row.account_id, 'UNREAD')
    const starredId = labelId(row.account_id, 'STARRED')
    const imap = row.kind === 'imap'
    let base: string[]
    if (imap) {
      const location = this.db
        .prepare(`
        SELECT json_group_array(DISTINCT label_id) AS labels,
          max(unread) AS unread, max(starred) AS starred
        FROM imap_location WHERE message_id = ?`)
        .get(id) as {
        labels: string
        unread: number | null
        starred: number | null
      }
      if (location.unread === null) return false
      base = JSON.parse(location.labels) as string[]
      if (location.unread) base.push(unreadId)
      if (location.starred) base.push(starredId)
    } else {
      base = JSON.parse(row.provider_label_ids ?? row.label_ids) as string[]
    }
    if (imap) observeSender(this, id, base)
    const projected = this.projectLabels(id, base).sort()
    const unread = Number(projected.includes(unreadId))
    const starred = Number(projected.includes(starredId))
    const labels = imap
      ? projected.filter((label) => label !== unreadId && label !== starredId)
      : projected
    if (
      unread === row.unread &&
      starred === row.starred &&
      JSON.stringify(labels) === JSON.stringify((JSON.parse(row.label_ids) as string[]).sort())
    )
      return false
    this.db
      .prepare('UPDATE message SET label_ids = ?, unread = ?, starred = ? WHERE id = ?')
      .run(JSON.stringify(labels), unread, starred, id)
    this.recordChange('message', id, 'upsert')
    return true
  }

  writeEpoch(accountId: string): number {
    const row = this.db.prepare('SELECT write_epoch FROM account WHERE id = ?').get(accountId) as
      | { write_epoch: number }
      | undefined
    return row?.write_epoch ?? 0
  }

  /** The effective provider label ids currently on a message, or null if unknown. */
  messageLabels(accountId: string, providerId: string): string[] | null {
    const row = this.db
      .prepare('SELECT label_ids FROM message WHERE id = ?')
      .get(messageId(accountId, providerId)) as { label_ids: string } | undefined
    if (!row) return null
    const prefix = `${accountId}:`
    return (JSON.parse(row.label_ids) as string[]).map((l) => l.slice(prefix.length))
  }

  setMessageFlags(
    accountId: string,
    providerId: string,
    flags: { unread: boolean; starred: boolean },
  ): void {
    transaction(this.db, () => {
      const mid = messageId(accountId, providerId)
      const row = this.db
        .prepare(
          'UPDATE message SET unread = ?, starred = ? WHERE id = ? AND (unread != ? OR starred != ?) RETURNING thread_id',
        )
        .get(+flags.unread, +flags.starred, mid, +flags.unread, +flags.starred) as
        | { thread_id: string }
        | undefined
      if (!row) return
      this.recordChange('message', mid, 'upsert')
      this.refreshThread(row.thread_id)
    })
  }

  mergeThreads(accountId: string, source: string, destination: string): void {
    if (source === destination) return
    const from = threadId(accountId, source)
    const to = threadId(accountId, destination)
    transaction(this.db, () => {
      if (!this.db.prepare('SELECT 1 FROM thread WHERE id = ?').get(from)) return
      this.db
        .prepare(
          'INSERT INTO thread (id, account_id, provider_thread_id) VALUES (?, ?, ?) ON CONFLICT (id) DO NOTHING',
        )
        .run(to, accountId, destination)
      this.db
        .prepare(`
          UPDATE thread
          SET (bucket, bucket_reason, bucket_set_by, bucket_set_at) = (
            SELECT bucket, bucket_reason, bucket_set_by, bucket_set_at FROM thread WHERE id = ?
          )
          WHERE id = ? AND bucket IS NULL
        `)
        .run(from, to)
      const moved = this.db
        .prepare('UPDATE message SET thread_id = ? WHERE thread_id = ? RETURNING id')
        .all(to, from) as { id: string }[]
      for (const { id } of moved) this.recordChange('message', id, 'upsert')
      this.refreshThread(to)
      this.refreshThread(from)
    })
  }

  deleteMessage(accountId: string, providerId: string): void {
    transaction(this.db, () => {
      const mid = messageId(accountId, providerId)
      const row = this.db.prepare('SELECT thread_id FROM message WHERE id = ?').get(mid) as
        | { thread_id: string }
        | undefined
      if (!row) return
      this.db.prepare('DELETE FROM message WHERE id = ?').run(mid)
      this.recordChange('message', mid, 'delete')
      this.refreshThread(row.thread_id)
    })
  }

  /** Recomputes a Thread's summary from its messages, or deletes it when none are left. */
  refreshThread(tid: string): void {
    const messages = this.db
      .prepare(
        `SELECT m.from_json, m.subject, m.snippet, m.sent_at, m.label_ids, m.unread, m.starred,
                a.kind AS account_kind,
                EXISTS (SELECT 1 FROM attachment at WHERE at.message_id = m.id AND at.inline = 0) AS files
         FROM message m JOIN account a ON a.id = m.account_id
         WHERE m.thread_id = ? ORDER BY m.sent_at DESC, m.rowid DESC`,
      )
      .iterate(tid) as Iterable<{
      from_json: string
      subject: string
      snippet: string
      sent_at: number
      label_ids: string
      unread: number
      starred: number
      files: number
      account_kind: string
    }>

    const labels = new Set<string>()
    const participants: Address[] = []
    const seen = new Set<string>()
    const accountPrefix = tid.slice(0, tid.indexOf(':') + 1)
    let inInbox = false
    let count = 0
    let unread = 0
    let starred = 0
    let hasAttachments = 0
    let subject = ''
    let snippet = ''
    let lastSentAt = 0
    for (const m of messages) {
      if (!count) {
        snippet = m.snippet
        lastSentAt = m.sent_at
      }
      count++
      unread += m.unread
      starred ||= m.starred
      hasAttachments ||= m.files
      subject = m.subject
      const messageLabels = JSON.parse(m.label_ids) as string[]
      for (const label of messageLabels) labels.add(label)
      inInbox ||=
        messageLabels.includes(`${accountPrefix}INBOX`) &&
        (m.account_kind === 'imap' ||
          (!messageLabels.includes(`${accountPrefix}TRASH`) &&
            !messageLabels.includes(`${accountPrefix}SPAM`)))
      const from = JSON.parse(m.from_json) as Address | null
      if (from && !seen.has(from.address.toLowerCase())) {
        seen.add(from.address.toLowerCase())
        participants.push(from)
      }
    }

    if (!count) {
      const existed = this.db.prepare('DELETE FROM thread WHERE id = ?').run(tid).changes > 0
      if (existed) this.recordChange('thread', tid, 'delete')
      return
    }

    this.db
      .prepare(
        `UPDATE thread SET subject = ?, snippet = ?, participants = ?, message_count = ?,
           unread_count = ?, starred = ?, in_inbox = (? AND muted = 0),
           has_attachments = ?, label_ids = ?,
           last_message_at = ?
         WHERE id = ?`,
      )
      .run(
        subject,
        snippet,
        JSON.stringify(participants),
        count,
        unread,
        starred,
        Number(inInbox),
        hasAttachments,
        JSON.stringify([...labels].sort()),
        lastSentAt,
        tid,
      )
    this.recordChange('thread', tid, 'upsert')
  }
}
