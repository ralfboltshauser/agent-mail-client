import { INLINE_IMAGE_TYPES } from '@amc/composer'
import type {
  Address,
  ComposeAttachment,
  ComposeDraft,
  ComposePatch,
  ComposeStart,
  Contact,
  Draft,
} from '@amc/protocol'
import * as Y from 'yjs'
import { newId } from '../auth/secrets.ts'
import { type Db, transaction } from '../db/database.ts'
import { GmailHttpError } from '../providers/gmail/http.ts'
import { fromGmail } from '../providers/gmail/mapping.ts'
import type { GmailApi, GmailDraft } from '../providers/gmail/types.ts'
import { draftDocument, renderDraft, replaceDraftContent } from './draft-document.ts'
import { buildMessage, replySubject } from './mime.ts'
import type { FrozenMessage } from './outbox.ts'
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
  provider_message_id: string | null
  to_json: string
  cc_json: string
  bcc_json: string
  subject: string
  body_text: string
  in_reply_to: string | null
  refs: string | null
  last_author: string
  updated_at: number
  modseq: number
  yjs: Uint8Array | null
  quote: string
  signature: string
  mirror_error: number
  mirror_dirty: number
}

export interface DraftMirror extends Pick<GmailApi, 'saveDraft' | 'deleteDraft'> {}

interface AttachmentRow extends ComposeAttachment {
  blob: string
}

export const MAX_ATTACHMENT_BYTES = 18 * 1024 * 1024

export class DraftError extends Error {}

/**
 * Drafts written by the owner or by Agents. Each one is mirrored to the provider's drafts, so
 * it is visible (and sendable by the owner) in Gmail. Nothing here can send (ADR 0001).
 */
export class Drafts {
  readonly #db: Db
  readonly #store: MailStore
  readonly #api: (accountId: string) => DraftMirror | null
  readonly #mirror = new Map<string, Promise<void>>()

  constructor(db: Db, store: MailStore, api: (accountId: string) => DraftMirror | null) {
    this.#db = db
    this.#store = store
    this.#api = api
  }

  get(id: string): Draft | null {
    const row = this.#row(id)
    return row ? this.#toDraft(row) : null
  }

  list(options: { threadId?: string; limit?: number; editable?: boolean } = {}): Draft[] {
    const rows = this.#db
      .prepare(
        `SELECT * FROM draft WHERE (?1 IS NULL OR thread_id = ?1)
           AND (?3 = 0 OR NOT EXISTS (SELECT 1 FROM outbox WHERE draft_id = draft.id AND status IN ('queued','dispatching','uncertain') AND released_at IS NULL))
           ORDER BY updated_at DESC LIMIT ?2`,
      )
      .all(
        options.threadId ?? null,
        Math.min(options.limit ?? 50, 200),
        Number(options.editable ?? false),
      ) as unknown as DraftRow[]
    return rows.map((r) => this.#toDraft(r))
  }

  compose(id: string): ComposeDraft | null {
    const row = this.#row(id)
    if (!row) return null
    // Persist the first seed before handing the document to any client.
    if (!row.yjs) {
      row.yjs = Y.encodeStateAsUpdate(draftDocument(null, row.body_text))
      this.#db.prepare('UPDATE draft SET yjs = ? WHERE id = ?').run(row.yjs, id)
    }
    return {
      ...this.#toDraft(row),
      update: Buffer.from(row.yjs).toString('base64'),
      revision: row.modseq,
      quote: row.quote,
      signature: row.signature,
      attachments: this.#attachments(id).map(({ id, filename, mimeType, size, contentId }) => ({
        id,
        filename,
        mimeType,
        size,
        contentId,
      })),
      mirrorError: Boolean(row.mirror_error),
    }
  }

  async startCompose(
    input: ComposeStart,
    fetchAttachment: (id: string) => Promise<string | null>,
  ): Promise<ComposeDraft> {
    const thread = input.threadId
      ? (this.#db
          .prepare(
            `SELECT t.account_id, t.subject, m.id, m.from_json, m.sent_at, m.body_text FROM thread t
        LEFT JOIN message m ON m.id = (
          SELECT id FROM message WHERE thread_id = t.id AND NOT EXISTS (
            SELECT 1 FROM json_each(label_ids) WHERE value = t.account_id || ':DRAFT'
          ) ORDER BY sent_at DESC LIMIT 1
        ) WHERE t.id = ?`,
          )
          .get(input.threadId) as
          | {
              account_id: string
              subject: string
              id: string | null
              from_json: string | null
              sent_at: number | null
              body_text: string | null
            }
          | undefined)
      : undefined
    if (input.mode !== 'new' && !thread) throw new DraftError('Open a Thread first')
    const accountId = input.accountId ?? thread?.account_id
    if (!accountId) throw new DraftError('Choose a From Account')
    this.#ownAddress(accountId)
    const forward = input.mode === 'forward'
    const forwardParts =
      forward && thread?.id
        ? await Promise.all(
            (
              this.#db
                .prepare(
                  'SELECT id, filename, mime_type, size FROM attachment WHERE message_id = ?',
                )
                .all(thread.id) as {
                id: string
                filename: string
                mime_type: string
                size: number
              }[]
            ).map(async (part) => {
              const blob = await fetchAttachment(part.id)
              if (!blob || !this.#store.blobs.get(blob))
                throw new DraftError(`Could not fetch ${part.filename}`)
              return { ...part, blob }
            }),
          )
        : []
    if (forwardParts.reduce((total, part) => total + part.size, 0) > MAX_ATTACHMENT_BYTES) {
      throw new DraftError('Forwarded attachments exceed the 18 MB limit')
    }
    const from = thread?.from_json ? (JSON.parse(thread.from_json) as Address | null) : null
    const quote =
      thread?.body_text && thread.sent_at !== null
        ? `On ${new Date(thread.sent_at).toISOString().slice(0, 10)}, ${from?.name ?? from?.address ?? 'the sender'} wrote:
` +
          thread.body_text
            .split('\n')
            .map((line) => `> ${line}`)
            .join('\n')
        : ''
    const draft = await this.create(
      {
        accountId,
        threadId: input.mode === 'reply' || input.mode === 'reply-all' ? input.threadId : undefined,
        replyAll: input.mode === 'reply-all',
        subject: forward
          ? /^\s*fwd:/i.test(thread?.subject ?? '')
            ? thread?.subject
            : `Fwd: ${thread?.subject ?? ''}`
          : undefined,
      },
      'owner',
      { quote, forwardParts },
    )
    return this.compose(draft.id) as ComposeDraft
  }

  openCompose(id: string): ComposeDraft | null {
    this.#checkEditable(id)
    return this.compose(id)
  }

  saveCompose(id: string, patch: ComposePatch): ComposeDraft {
    const current = this.compose(id)
    if (!current) throw new DraftError('Draft does not exist')
    this.#checkEditable(id)
    const fields = patch.fields
    const accountId = fields?.accountId ?? current.accountId
    if (fields && patch.baseRevision !== current.revision) {
      throw new DraftError(
        'The recipients, subject or attachments may have changed. Reopen the draft to review them.',
      )
    }
    this.#ownAddress(accountId)
    const row = this.#row(id) as DraftRow
    const doc = draftDocument(row.yjs, row.body_text)
    let text: string
    try {
      Y.applyUpdate(doc, Buffer.from(patch.update, 'base64'))
      if (doc.store.pendingStructs || doc.store.pendingDs)
        throw new Error('Missing Yjs dependencies')
      text = renderDraft(doc).text
    } catch {
      throw new DraftError('Could not apply the document update')
    }
    const attachmentIds = fields?.attachmentIds ?? current.attachments.map((part) => part.id)
    const attachments = new Set(attachmentIds)
    const known = this.#attachments(id, false)
    if (attachmentIds.some((attachmentId) => !known.some((part) => part.id === attachmentId))) {
      throw new DraftError('Unknown draft attachment')
    }
    if (
      known.filter((part) => attachments.has(part.id)).reduce((size, part) => size + part.size, 0) >
      MAX_ATTACHMENT_BYTES
    ) {
      throw new DraftError('Attachments exceed the 18 MB limit')
    }
    transaction(this.#db, () => {
      if (current.accountId !== accountId && row.provider_draft_id) {
        this.#queueMirrorRemoval(current.accountId, row.provider_draft_id)
      }
      const signature = current.accountId === accountId ? row.signature : this.signature(accountId)
      this.#db
        .prepare(
          `UPDATE draft SET signature = ?, account_id = ?, to_json = ?, cc_json = ?, bcc_json = ?, subject = ?,
          body_text = ?, yjs = ?, updated_at = ?, last_author = 'owner', mirror_dirty = 1,
          provider_draft_id = CASE WHEN account_id = ? THEN provider_draft_id ELSE NULL END,
          provider_message_id = CASE WHEN account_id = ? THEN provider_message_id ELSE NULL END
          WHERE id = ?`,
        )
        .run(
          signature,
          accountId,
          JSON.stringify(fields?.to ?? current.to),
          JSON.stringify(fields?.cc ?? current.cc),
          JSON.stringify(fields?.bcc ?? current.bcc),
          fields?.subject ?? current.subject,
          text,
          Y.encodeStateAsUpdate(doc),
          Date.now(),
          accountId,
          accountId,
          id,
        )
      for (const part of known) {
        this.#db
          .prepare('UPDATE draft_attachment SET active = ? WHERE id = ?')
          .run(+attachments.has(part.id), part.id)
      }
      this.#store.recordChange('draft', id, 'upsert')
    })
    return this.compose(id) as ComposeDraft
  }

  addAttachment(
    id: string,
    filename: string,
    mimeType: string,
    bytes: Buffer,
    inline = false,
  ): ComposeAttachment {
    if (!this.#row(id)) throw new DraftError('Draft does not exist')
    this.#checkEditable(id)
    if (bytes.length > MAX_ATTACHMENT_BYTES)
      throw new DraftError('Attachment exceeds the 18 MB limit')
    const attachmentId = newId('att')
    if (inline && !INLINE_IMAGE_TYPES.includes(mimeType))
      throw new DraftError('Unsupported inline image type')
    const part = {
      id: attachmentId,
      filename,
      mimeType,
      size: bytes.length,
      contentId: inline ? `${attachmentId}@amc.local` : null,
    }
    this.#db
      .prepare(
        'INSERT INTO draft_attachment (id, draft_id, filename, mime_type, size, blob, content_id, active) VALUES (?, ?, ?, ?, ?, ?, ?, 0)',
      )
      .run(
        part.id,
        id,
        filename,
        mimeType,
        bytes.length,
        this.#store.blobs.put(bytes),
        part.contentId,
      )
    return part
  }

  inlineImage(id: string, contentId: string) {
    const part = this.#attachments(id, false).find(
      (attachment) => attachment.contentId === contentId,
    )
    if (!part || !INLINE_IMAGE_TYPES.includes(part.mimeType)) return null
    const bytes = this.#store.blobs.get(part.blob)
    return bytes ? { mimeType: part.mimeType, content: bytes.toString('base64') } : null
  }

  signature(accountId: string): string {
    this.#ownAddress(accountId)
    return this.#db.prepare('SELECT signature FROM account WHERE id = ?').get(accountId)
      ?.signature as string
  }

  setSignature(accountId: string, value: string): void {
    this.#ownAddress(accountId)
    this.#db.prepare('UPDATE account SET signature = ? WHERE id = ?').run(value, accountId)
  }

  freeze(id: string, revision: number): FrozenMessage {
    const row = this.#row(id)
    if (!row || row.modseq !== revision)
      throw new DraftError('The draft changed. Save it again before sending.')
    const message = this.#message(row)
    const recipient = /^[^\s<>@,;:"()\\]+@[a-z0-9.-]+$/i
    if (
      ![...message.to, ...message.cc, ...message.bcc].every((address) =>
        recipient.test(address.address),
      )
    ) {
      throw new DraftError('One or more recipient addresses are invalid')
    }
    return message
  }

  finishSend(message: FrozenMessage): void {
    const row = this.#row(message.draftId)
    if (row?.modseq !== message.revision) return
    if (row.provider_draft_id) this.#queueMirrorRemoval(row.account_id, row.provider_draft_id)
    this.#db.prepare('DELETE FROM draft WHERE id = ?').run(row.id)
    this.#store.recordChange('draft', row.id, 'delete')
  }

  async mirrorPending(): Promise<void> {
    const pending = this.#db
      .prepare(
        `SELECT id FROM draft WHERE mirror_dirty = 1 AND NOT EXISTS (
        SELECT 1 FROM outbox WHERE outbox.draft_id = draft.id AND outbox.status IN ('queued','dispatching','uncertain') AND released_at IS NULL
      ) ORDER BY updated_at DESC LIMIT 10`,
      )
      .all() as { id: string }[]
    await Promise.allSettled(pending.map(({ id }) => this.#push(id)))
    const removals = this.#db
      .prepare('SELECT account_id, provider_draft_id FROM draft_mirror_removal LIMIT 20')
      .all() as { account_id: string; provider_draft_id: string }[]
    await Promise.allSettled(
      removals.map(async ({ account_id, provider_draft_id }) => {
        const api = this.#api(account_id)
        if (!api) return
        await api.deleteDraft(provider_draft_id)
        this.#db
          .prepare(
            'DELETE FROM draft_mirror_removal WHERE account_id = ? AND provider_draft_id = ?',
          )
          .run(account_id, provider_draft_id)
      }),
    )
  }

  async pullGmail(accountId: string, api: GmailApi): Promise<void> {
    const seen = new Set<string>()
    let pageToken: string | undefined
    do {
      const page = await api.listDrafts(pageToken)
      for (const item of page.drafts ?? []) {
        seen.add(item.id)
        await this.#pullGmailDraft(accountId, item, api)
      }
      pageToken = page.nextPageToken
    } while (pageToken)
    const known = this.#db
      .prepare(
        `SELECT * FROM draft WHERE account_id = ? AND provider_draft_id IS NOT NULL AND mirror_dirty = 0`,
      )
      .all(accountId) as unknown as DraftRow[]
    for (const local of known) {
      if (seen.has(local.provider_draft_id as string) || !this.#canImport(local)) continue
      if (await api.getDraft(local.provider_draft_id as string)) continue
      transaction(this.#db, () => {
        const current = this.#row(local.id)
        if (
          current?.modseq !== local.modseq ||
          current.provider_draft_id !== local.provider_draft_id ||
          !this.#canImport(current)
        )
          return
        this.#db.prepare('DELETE FROM draft WHERE id = ?').run(local.id)
        this.#store.recordChange('draft', local.id, 'delete')
      })
    }
  }

  async #pullGmailDraft(accountId: string, item: GmailDraft, api: GmailApi): Promise<void> {
    const lookup = () =>
      this.#db
        .prepare('SELECT * FROM draft WHERE account_id = ? AND provider_draft_id = ?')
        .get(accountId, item.id) as unknown as DraftRow | undefined
    if (
      this.#db
        .prepare(
          'SELECT 1 FROM draft_mirror_removal WHERE account_id = ? AND provider_draft_id = ?',
        )
        .get(accountId, item.id)
    )
      return
    const previous = lookup()
    if (
      previous &&
      (previous.provider_message_id === item.message.id || !this.#canImport(previous))
    )
      return
    // An outbound create may have reached Gmail just before its local draft ID was recorded.
    if (!previous && this.#mirror.size > 0) return
    const resource = await api.getMessage(item.message.id, true)
    if (!resource?.labelIds?.includes('DRAFT') || !resource.payload) return
    const incoming = fromGmail(resource)
    if (incoming.attachments.reduce((total, part) => total + part.size, 0) > MAX_ATTACHMENT_BYTES)
      return
    const parts = await Promise.all(
      incoming.attachments.map(async (part) => {
        const bytes =
          part.data ??
          (part.providerAttachmentId
            ? await api.attachment(resource.id, part.providerAttachmentId)
            : undefined)
        if (!bytes) throw new DraftError('Gmail draft attachment unavailable')
        return { ...part, size: bytes.byteLength, blob: this.#store.blobs.put(bytes) }
      }),
    )
    if (parts.reduce((total, part) => total + part.size, 0) > MAX_ATTACHMENT_BYTES) return

    transaction(this.#db, () => {
      const current = lookup()
      if (
        previous?.id !== current?.id ||
        previous?.modseq !== current?.modseq ||
        (current && !this.#canImport(current))
      )
        return
      if (
        !current &&
        (this.#mirror.size > 0 ||
          this.#db
            .prepare(
              'SELECT 1 FROM draft_mirror_removal WHERE account_id = ? AND provider_draft_id = ?',
            )
            .get(accountId, item.id))
      )
        return
      const id = current?.id ?? newId('drf')
      const doc = draftDocument(current?.yjs ?? null, current?.body_text ?? '')
      replaceDraftContent(doc, incoming.bodyText, incoming.bodyHtml)
      const { text } = renderDraft(doc)
      const target = `${accountId}:${incoming.providerThreadId}`
      const threadId =
        incoming.inReplyTo && this.#db.prepare('SELECT 1 FROM thread WHERE id = ?').get(target)
          ? target
          : null
      const now = Date.now()
      this.#db
        .prepare(
          `INSERT INTO draft (id, account_id, thread_id, provider_draft_id, provider_message_id,
          to_json, cc_json, bcc_json, subject, body_text, yjs, last_author, updated_at, created_at, in_reply_to, refs)
         VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, 'owner', ?, ?, ?, ?)
         ON CONFLICT (id) DO UPDATE SET thread_id = excluded.thread_id, provider_message_id = excluded.provider_message_id,
          to_json = excluded.to_json, cc_json = excluded.cc_json, bcc_json = excluded.bcc_json, subject = excluded.subject,
          body_text = excluded.body_text, yjs = excluded.yjs, last_author = excluded.last_author, updated_at = excluded.updated_at,
          in_reply_to = excluded.in_reply_to, refs = excluded.refs, quote = '', signature = ''`,
        )
        .run(
          id,
          accountId,
          threadId,
          item.id,
          resource.id,
          JSON.stringify(incoming.to),
          JSON.stringify(incoming.cc),
          JSON.stringify(incoming.bcc),
          incoming.subject,
          text,
          Y.encodeStateAsUpdate(doc),
          now,
          now,
          incoming.inReplyTo,
          incoming.references,
        )
      this.#db.prepare('UPDATE draft_attachment SET active = 0 WHERE draft_id = ?').run(id)
      for (const part of parts) {
        this.#db
          .prepare(
            'INSERT INTO draft_attachment (id, draft_id, filename, mime_type, size, blob, content_id) VALUES (?, ?, ?, ?, ?, ?, ?)',
          )
          .run(
            newId('att'),
            id,
            part.filename || 'attachment',
            part.mimeType,
            part.size,
            part.blob,
            part.contentId && incoming.bodyHtml?.includes(`cid:${part.contentId}`)
              ? part.contentId
              : null,
          )
      }
      this.#store.recordChange('draft', id, 'upsert')
    })
  }

  #canImport(row: DraftRow): boolean {
    return !row.mirror_dirty && !this.#mirror.has(row.id) && !this.#hasActiveSend(row.id)
  }

  #queueMirrorRemoval(accountId: string, id: string) {
    this.#db.prepare('INSERT OR IGNORE INTO draft_mirror_removal VALUES (?, ?)').run(accountId, id)
  }

  #hasActiveSend(id: string): boolean {
    return Boolean(
      this.#db
        .prepare(
          "SELECT 1 FROM outbox WHERE draft_id = ? AND status IN ('queued','dispatching','uncertain') AND released_at IS NULL",
        )
        .get(id),
    )
  }

  #checkEditable(id: string) {
    if (this.#hasActiveSend(id))
      throw new DraftError('Cancel the send in the Outbox before editing this draft')
  }

  #attachments(id: string, active = true): AttachmentRow[] {
    return this.#db
      .prepare(
        'SELECT id, filename, mime_type AS mimeType, size, blob, content_id AS contentId FROM draft_attachment WHERE draft_id = ? AND (? = 0 OR active = 1) ORDER BY rowid',
      )
      .all(id, +active) as unknown as AttachmentRow[]
  }

  #message(row: DraftRow): FrozenMessage {
    const { text, html } = renderDraft(draftDocument(row.yjs, row.body_text))
    const escapeHtml = (value: string) =>
      value.replace(/[&<>]/g, (ch) => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;' })[ch] as string)
    const signature = row.signature
      ? `<div style="white-space:pre-wrap">${escapeHtml(row.signature)}</div>`
      : ''
    const quoteHtml = row.quote
      ? `<blockquote style="white-space:pre-wrap">${escapeHtml(row.quote)}</blockquote>`
      : ''
    return {
      accountId: row.account_id,
      draftId: row.id,
      revision: row.modseq,
      providerDraftId: row.provider_draft_id,
      threadId: row.thread_id?.startsWith(`${row.account_id}:`) ? row.thread_id : null,
      from: { address: this.#ownAddress(row.account_id), name: null },
      to: JSON.parse(row.to_json),
      cc: JSON.parse(row.cc_json),
      bcc: JSON.parse(row.bcc_json),
      subject: row.subject,
      text: [text, row.signature, row.quote].filter(Boolean).join('\n\n'),
      html: html + signature + quoteHtml,
      inReplyTo: row.in_reply_to,
      references: row.refs,
      attachments: this.#attachments(row.id)
        .filter((part) => !part.contentId || html.includes(`src="cid:${part.contentId}"`))
        .map((part) => {
          const bytes = this.#store.blobs.get(part.blob)
          if (!bytes) throw new DraftError(`Attachment ${part.filename} is unavailable`)
          return {
            filename: part.filename,
            mimeType: part.mimeType,
            content: bytes.toString('base64'),
            contentId: part.contentId ?? undefined,
          }
        }),
    }
  }

  async create(
    input: DraftInput,
    author: string,
    compose?: {
      quote: string
      forwardParts: { filename: string; mime_type: string; size: number; blob: string }[]
    },
  ): Promise<Draft> {
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
      accountId = compose ? (input.accountId ?? thread.account_id) : thread.account_id
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
        inReplyTo = last.rfc_message_id?.replace(/^<|>$/g, '') ?? null
        refs = [last.refs, inReplyTo ? `<${inReplyTo}>` : null].filter(Boolean).join(' ') || null
      }
      subject = input.subject ?? replySubject(thread.subject)
    }
    if (!accountId) throw new DraftError('accountId is required for a new message')
    const body = input.body ?? ''
    const signature = compose ? this.signature(accountId) : ''
    const state = Y.encodeStateAsUpdate(draftDocument(null, body))

    const id = newId('drf')
    transaction(this.#db, () => {
      this.#db
        .prepare(
          `INSERT INTO draft (id, account_id, thread_id, to_json, cc_json, bcc_json, subject, body_text,
           in_reply_to, refs, last_author, created_at, updated_at, yjs, quote, signature, mirror_dirty)
         VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, 1)`,
        )
        .run(
          id,
          accountId,
          input.threadId ?? null,
          JSON.stringify(to),
          JSON.stringify(cc),
          JSON.stringify(input.bcc ?? []),
          subject,
          body,
          inReplyTo,
          refs,
          author,
          now,
          now,
          state,
          compose?.quote ?? '',
          signature,
        )
      for (const part of compose?.forwardParts ?? []) {
        this.#db
          .prepare(
            'INSERT INTO draft_attachment (id, draft_id, filename, mime_type, size, blob, content_id) VALUES (?, ?, ?, ?, ?, ?, ?)',
          )
          .run(newId('att'), id, part.filename, part.mime_type, part.size, part.blob, null)
      }
      this.#store.recordChange('draft', id, 'upsert')
    })
    if (!compose) await this.#push(id)
    return this.get(id) as Draft
  }

  async update(
    id: string,
    patch: Omit<DraftInput, 'threadId' | 'accountId' | 'replyAll'>,
    author: string,
  ): Promise<Draft> {
    const row = this.#row(id)
    if (!row) throw new DraftError(`No draft ${id}`)
    this.#checkEditable(id)
    const doc = draftDocument(row.yjs, row.body_text)
    if (patch.body !== undefined) replaceDraftContent(doc, patch.body)
    transaction(this.#db, () => {
      this.#db
        .prepare(
          `UPDATE draft SET to_json = ?, cc_json = ?, bcc_json = ?, subject = ?, body_text = ?,
           last_author = ?, updated_at = ?, yjs = ?, mirror_dirty = 1 WHERE id = ?`,
        )
        .run(
          patch.to ? JSON.stringify(patch.to) : row.to_json,
          patch.cc ? JSON.stringify(patch.cc) : row.cc_json,
          patch.bcc ? JSON.stringify(patch.bcc) : row.bcc_json,
          patch.subject ?? row.subject,
          patch.body ?? row.body_text,
          author,
          Date.now(),
          Y.encodeStateAsUpdate(doc),
          id,
        )
      this.#store.recordChange('draft', id, 'upsert')
    })
    await this.#push(id)
    return this.get(id) as Draft
  }

  async delete(id: string): Promise<void> {
    const row = this.#row(id)
    if (!row) return
    this.#checkEditable(id)
    transaction(this.#db, () => {
      if (row.provider_draft_id) this.#queueMirrorRemoval(row.account_id, row.provider_draft_id)
      this.#db.prepare('DELETE FROM draft WHERE id = ?').run(id)
      this.#store.recordChange('draft', id, 'delete')
    })
    await this.mirrorPending()
  }

  #push(id: string): Promise<void> {
    const existing = this.#mirror.get(id)
    if (existing) return existing
    const pending = this.#pushOnce(id).finally(() => this.#mirror.delete(id))
    this.#mirror.set(id, pending)
    return pending
  }

  async #pushOnce(id: string): Promise<void> {
    const row = this.#row(id)
    if (!row) return
    try {
      const api = this.#api(row.account_id)
      if (!api) throw new Error('Account is unavailable')
      const message = this.#message(row)
      const raw = await buildMessage(message)
      const providerThread = message.threadId?.slice(row.account_id.length + 1)
      const saved = await api.saveDraft({
        draftId: row.provider_draft_id ?? undefined,
        raw,
        threadId: providerThread,
      })
      transaction(this.#db, () => {
        const updated = this.#db
          .prepare(
            `UPDATE draft SET provider_draft_id = ?, provider_message_id = ?, mirror_error = 0,
             mirror_dirty = CASE WHEN modseq = ? THEN 0 ELSE 1 END WHERE id = ? AND account_id = ? AND provider_draft_id IS ?`,
          )
          .run(saved.id, saved.message.id, row.modseq, id, row.account_id, row.provider_draft_id)
        if (!updated.changes) this.#queueMirrorRemoval(row.account_id, saved.id)
        else if (row.provider_draft_id && row.provider_draft_id !== saved.id) {
          this.#queueMirrorRemoval(row.account_id, row.provider_draft_id)
        }
      })
    } catch (error) {
      if (row.provider_draft_id && error instanceof GmailHttpError && error.status === 404) {
        this.#db
          .prepare(
            'UPDATE draft SET provider_draft_id = NULL, provider_message_id = NULL WHERE id = ? AND account_id = ? AND provider_draft_id = ?',
          )
          .run(id, row.account_id, row.provider_draft_id)
      }
      this.#db
        .prepare('UPDATE draft SET mirror_error = 1 WHERE id = ? AND account_id = ?')
        .run(id, row.account_id)
    }
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
