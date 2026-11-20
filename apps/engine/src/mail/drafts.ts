import type { Address, Contact, Draft } from '@amc/protocol'
import { newId } from '../auth/secrets.ts'
import type { Db } from '../db/database.ts'
import type { GmailApi } from '../providers/gmail/types.ts'
import { buildMessage, replySubject } from './mime.ts'
import type { MailStore } from './store.ts'

export interface DraftInput {
  /** Reply in this Thread (recipients, subject and threading headers default from it). */
  threadId?: string
  /** Required when not replying. */
  accountId?: string
  to?: Address[]
  cc?: Address[]
  bcc?: Address[]
  subject?: string
  body?: string
  /** Reply to everyone on the last message, not only its sender. */
  replyAll?: boolean
}

interface DraftRow {
  id: string
  account_id: string
  thread_id: string | null
  provider_draft_id: string | null
  to_json: string
  cc_json: string
  bcc_json: string
  subject: string
  body_text: string
  in_reply_to: string | null
  refs: string | null
  last_author: string
  updated_at: number
}

export class DraftError extends Error {}

/**
 * Drafts written by the owner or by Agents. Each one is mirrored to the provider's drafts, so
 * it is visible (and sendable by the owner) in Gmail. Nothing here can send (ADR 0001).
 */
export class Drafts {
  readonly #db: Db
  readonly #store: MailStore
  readonly #api: (accountId: string) => GmailApi | null

  constructor(db: Db, store: MailStore, api: (accountId: string) => GmailApi | null) {
    this.#db = db
    this.#store = store
    this.#api = api
  }

  get(id: string): Draft | null {
    const row = this.#row(id)
    return row ? this.#toDraft(row) : null
  }

  list(options: { threadId?: string; limit?: number } = {}): Draft[] {
    const rows = this.#db
      .prepare(
        `SELECT * FROM draft WHERE (?1 IS NULL OR thread_id = ?1) ORDER BY updated_at DESC LIMIT ?2`,
      )
      .all(options.threadId ?? null, Math.min(options.limit ?? 50, 200)) as unknown as DraftRow[]
    return rows.map((r) => this.#toDraft(r))
  }

  async create(input: DraftInput, author: string): Promise<Draft> {
    const now = Date.now()
    let accountId = input.accountId
    let to = input.to ?? []
    let cc = input.cc ?? []
    let subject = input.subject ?? ''
    let inReplyTo: string | null = null
    let refs: string | null = null

    if (input.threadId) {
      const thread = this.#db
        .prepare('SELECT account_id, subject FROM thread WHERE id = ?')
        .get(input.threadId) as { account_id: string; subject: string } | undefined
      if (!thread) throw new DraftError(`No Thread ${input.threadId}`)
      accountId = thread.account_id
      const own = this.#ownAddress(accountId)
      const last = this.#db
        .prepare(
          `SELECT rfc_message_id, refs, from_json, to_json, cc_json, reply_to_json FROM message
           WHERE thread_id = ? AND NOT EXISTS (SELECT 1 FROM json_each(label_ids) WHERE value = ?)
           ORDER BY sent_at DESC LIMIT 1`,
        )
        .get(input.threadId, `${accountId}:DRAFT`) as
        | {
            rfc_message_id: string | null
            refs: string | null
            from_json: string
            to_json: string
            cc_json: string
            reply_to_json: string
          }
        | undefined
      if (last) {
        const from = JSON.parse(last.from_json) as Address | null
        const replyTo = JSON.parse(last.reply_to_json) as Address[]
        const lastTo = JSON.parse(last.to_json) as Address[]
        const fromSelf = from?.address.toLowerCase() === own.toLowerCase()
        // Replying to my own message goes to its recipients, otherwise to the sender.
        const defaultTo = fromSelf ? lastTo : replyTo.length ? replyTo : from ? [from] : []
        to = input.to ?? defaultTo
        if (input.replyAll && !input.cc) {
          const seen = new Set([own.toLowerCase(), ...to.map((a) => a.address.toLowerCase())])
          cc = [...lastTo, ...(JSON.parse(last.cc_json) as Address[])].filter((a) => {
            const key = a.address.toLowerCase()
            if (seen.has(key)) return false
            seen.add(key)
            return true
          })
        }
        inReplyTo = last.rfc_message_id
        refs =
          [last.refs, last.rfc_message_id ? `<${last.rfc_message_id}>` : null]
            .filter(Boolean)
            .join(' ') || null
      }
      subject = input.subject ?? replySubject(thread.subject)
    }
    if (!accountId) throw new DraftError('accountId is required for a new message')

    const id = newId('drf')
    this.#db
      .prepare(
        `INSERT INTO draft (id, account_id, thread_id, to_json, cc_json, bcc_json, subject, body_text,
           in_reply_to, refs, last_author, created_at, updated_at)
         VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`,
      )
      .run(
        id,
        accountId,
        input.threadId ?? null,
        JSON.stringify(to),
        JSON.stringify(cc),
        JSON.stringify(input.bcc ?? []),
        subject,
        input.body ?? '',
        inReplyTo,
        refs,
        author,
        now,
        now,
      )
    await this.#push(id)
    this.#store.recordChange('draft', id, 'upsert')
    return this.get(id) as Draft
  }

  async update(
    id: string,
    patch: Omit<DraftInput, 'threadId' | 'accountId' | 'replyAll'>,
    author: string,
  ): Promise<Draft> {
    const row = this.#row(id)
    if (!row) throw new DraftError(`No draft ${id}`)
    this.#db
      .prepare(
        `UPDATE draft SET to_json = ?, cc_json = ?, bcc_json = ?, subject = ?, body_text = ?,
           last_author = ?, updated_at = ? WHERE id = ?`,
      )
      .run(
        patch.to ? JSON.stringify(patch.to) : row.to_json,
        patch.cc ? JSON.stringify(patch.cc) : row.cc_json,
        patch.bcc ? JSON.stringify(patch.bcc) : row.bcc_json,
        patch.subject ?? row.subject,
        patch.body ?? row.body_text,
        author,
        Date.now(),
        id,
      )
    await this.#push(id)
    this.#store.recordChange('draft', id, 'upsert')
    return this.get(id) as Draft
  }

  async delete(id: string): Promise<void> {
    const row = this.#row(id)
    if (!row) return
    if (row.provider_draft_id) await this.#api(row.account_id)?.deleteDraft(row.provider_draft_id)
    this.#db.prepare('DELETE FROM draft WHERE id = ?').run(id)
    this.#store.recordChange('draft', id, 'delete')
  }

  /** Mirrors the draft to the provider so it appears in Gmail. */
  async #push(id: string): Promise<void> {
    const row = this.#row(id)
    if (!row) return
    const api = this.#api(row.account_id)
    if (!api) throw new DraftError('The Account is not syncing right now; try again shortly')
    const providerThread = row.thread_id
      ? row.thread_id.slice(row.thread_id.indexOf(':') + 1)
      : undefined
    const raw = buildMessage({
      from: { name: null, address: this.#ownAddress(row.account_id) },
      to: JSON.parse(row.to_json),
      cc: JSON.parse(row.cc_json),
      bcc: JSON.parse(row.bcc_json),
      subject: row.subject,
      text: row.body_text,
      inReplyTo: row.in_reply_to,
      references: row.refs,
    })
    const saved = await api.saveDraft({
      ...(row.provider_draft_id ? { draftId: row.provider_draft_id } : {}),
      raw,
      ...(providerThread ? { threadId: providerThread } : {}),
    })
    this.#db
      .prepare('UPDATE draft SET provider_draft_id = ?, provider_message_id = ? WHERE id = ?')
      .run(saved.id, saved.message.id, id)
  }

  #row(id: string): DraftRow | undefined {
    return this.#db.prepare('SELECT * FROM draft WHERE id = ?').get(id) as unknown as
      | DraftRow
      | undefined
  }

  #ownAddress(accountId: string): string {
    const row = this.#db.prepare('SELECT address FROM account WHERE id = ?').get(accountId) as
      | { address: string }
      | undefined
    if (!row) throw new DraftError(`No Account ${accountId}`)
    return row.address
  }

  #toDraft(r: DraftRow): Draft {
    return {
      id: r.id,
      accountId: r.account_id,
      threadId: r.thread_id,
      from: this.#ownAddress(r.account_id),
      to: JSON.parse(r.to_json),
      cc: JSON.parse(r.cc_json),
      bcc: JSON.parse(r.bcc_json),
      subject: r.subject,
      body: r.body_text,
      lastAuthor: r.last_author,
      updatedAt: r.updated_at,
    }
  }
}

export function searchContacts(db: Db, query: string, limit = 10): Contact[] {
  const like = `%${query.toLowerCase().replace(/[%_]/g, '')}%`
  const rows = db
    .prepare(
      `SELECT address, name, last_seen_at, received_count, sent_count FROM contact
       WHERE address LIKE ?1 OR lower(name) LIKE ?1
       ORDER BY sent_count * 3 + received_count DESC, last_seen_at DESC LIMIT ?2`,
    )
    .all(like, Math.min(limit, 50)) as {
    address: string
    name: string | null
    last_seen_at: number
    received_count: number
    sent_count: number
  }[]
  return rows.map((r) => ({
    address: r.address,
    name: r.name,
    lastSeenAt: r.last_seen_at,
    receivedCount: r.received_count,
    sentCount: r.sent_count,
  }))
}
