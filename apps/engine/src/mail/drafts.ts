import { createHash } from 'node:crypto'
import { INLINE_IMAGE_TYPES } from '@amc/composer'
import type {
  Address,
  ComposeAttachment,
  ComposeDraft,
  ComposePatch,
  ComposeStart,
  Contact,
  DiscardDraftResult,
  Draft,
  SendRequest,
} from '@amc/protocol'
import { DRAFT_CHANGED, MIRROR_CHANGED } from '@amc/protocol'
import type { MessageStructureObject } from 'imapflow'
import * as Y from 'yjs'
import { newId } from '../auth/secrets.ts'
import type { Principal } from '../auth/tokens.ts'
import { type Db, transaction } from '../db/database.ts'
import { fromGmail } from '../providers/gmail/mapping.ts'
import type { GmailApi, GmailDraft } from '../providers/gmail/types.ts'
import { parseMessage } from '../providers/imap/mapping.ts'
import { draftSourceHash, type ImapProvider } from '../providers/imap/provider.ts'
import {
  applyDraftUpdate,
  draftDocument,
  editDraftText,
  renderDraft,
  replaceDraftContent,
} from './draft-document.ts'
import { buildMessage, replySubject } from './mime.ts'
import type { FrozenMessage, Outbox } from './outbox.ts'
import type { IncomingMessage, MailStore } from './store.ts'

export type VersionedDraft = Draft & { revision: number }

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
  mirror_hash: string | null
  mirror_written_hash: string | null
  mirror_conflict: number
  mirror_left: number
  imap_content: string | null
}

export interface DraftMirror {
  imap?: true
  saveDraft(
    input: Parameters<GmailApi['saveDraft']>[0],
  ): Promise<GmailDraft & { sourceHash?: string }>
  deleteDraft(id: string, sourceHash?: string | null): Promise<boolean>
  getDraft?: GmailApi['getDraft']
}

interface ImapContent {
  text?: string
  html?: string
  editorHtml: string
  editorText: string
  complete: boolean
}

function canRepresentMime(
  structure: MessageStructureObject | undefined,
  parts: { mimeType: string; contentId: string | null }[],
): boolean {
  if (!structure) return false
  let index = 0
  const parametersAre = (parameters: Record<string, string> | undefined, allowed: string[]) =>
    Object.keys(parameters ?? {}).every((key) => allowed.includes(key))

  function leaf(node: MessageStructureObject): boolean {
    return (
      !node.childNodes?.length &&
      !node.type.startsWith('message/') &&
      !node.description &&
      !node.location &&
      !node.language?.length &&
      parametersAre(node.dispositionParameters, ['filename'])
    )
  }

  function attachment(node: MessageStructureObject): boolean {
    const part = parts[index++]
    return (
      !!part &&
      leaf(node) &&
      parametersAre(node.parameters, ['name']) &&
      node.type === part.mimeType &&
      (node.id?.replace(/^<|>$/g, '') ?? null) === part.contentId
    )
  }

  function text(node: MessageStructureObject, type: string): boolean {
    return (
      node.type === type &&
      leaf(node) &&
      !node.id &&
      (!node.disposition || node.disposition === 'inline') &&
      parametersAre(node.parameters, ['charset'])
    )
  }

  function body(node: MessageStructureObject): boolean {
    const children = node.childNodes ?? []
    if (node.type === 'multipart/alternative') {
      const [plain, rich] = children
      return (
        parametersAre(node.parameters, ['boundary']) &&
        children.length === 2 &&
        !!plain &&
        !!rich &&
        text(plain, 'text/plain') &&
        (text(rich, 'text/html') || (rich.type === 'multipart/related' && body(rich)))
      )
    }
    if (node.type === 'multipart/related') {
      const [root, ...related] = children
      return (
        parametersAre(node.parameters, ['boundary', 'type']) &&
        !!root &&
        (text(root, 'text/html') || (root.type === 'multipart/alternative' && body(root))) &&
        related.every(attachment)
      )
    }
    return text(node, 'text/plain') || text(node, 'text/html')
  }

  const [root, ...files] = structure.childNodes ?? []
  const represented =
    structure.type === 'multipart/mixed'
      ? parametersAre(structure.parameters, ['boundary']) &&
        !!root &&
        body(root) &&
        files.every(attachment)
      : body(structure)
  return represented && index === parts.length
}

function mirrorHash(messageId: string): string {
  // Replacing a Gmail draft message always assigns a new immutable message ID.
  return createHash('sha256').update(messageId).digest('hex')
}

interface MirrorRemoval {
  account_id: string
  provider_draft_id: string
  mirror_hash: string | null
  draft_id: string
}

interface AttachmentRow extends ComposeAttachment {
  blob: string
  disposition: 'attachment' | 'inline' | null
}

function escapeHtml(value: string): string {
  return value.replace(/[&<>]/g, (ch) => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;' })[ch] as string)
}

export const MAX_ATTACHMENT_BYTES = 18 * 1024 * 1024

export class DraftError extends Error {
  readonly status: 400 | 409

  constructor(message: string, status: 400 | 409 = 400) {
    super(message)
    this.status = status
  }
}

export class DraftRevisionConflict extends DraftError {
  readonly body: string
  readonly revision: number

  constructor(body: string, revision: number) {
    super('The draft changed. Incorporate the current text before retrying.', 409)
    this.body = body
    this.revision = revision
  }
}

/**
 * Drafts written by the owner or by Agents. Each one is mirrored to the provider's drafts, so
 * it is visible (and sendable by the owner) in Gmail. Nothing here can send (ADR 0001).
 */
export class Drafts {
  readonly #db: Db
  readonly #store: MailStore
  readonly #api: (accountId: string) => DraftMirror | null
  readonly #mirror = new Map<string, Promise<unknown>>()

  constructor(db: Db, store: MailStore, api: (accountId: string) => DraftMirror | null) {
    this.#db = db
    this.#store = store
    this.#api = api
  }

  get(id: string): VersionedDraft | null {
    const row = this.#row(id)
    return row ? this.#toDraft(row) : null
  }

  list(
    options: { threadId?: string; accountId?: string; limit?: number; editable?: boolean } = {},
  ): Draft[] {
    const rows = this.#db
      .prepare(
        `SELECT * FROM draft WHERE (?1 IS NULL OR thread_id = ?1) AND (?4 IS NULL OR account_id = ?4)
           AND (?3 = 0 OR NOT EXISTS (SELECT 1 FROM outbox WHERE draft_id = draft.id AND status IN ('queued','dispatching','uncertain') AND released_at IS NULL))
           ORDER BY updated_at DESC LIMIT ?2`,
      )
      .all(
        options.threadId ?? null,
        Math.min(options.limit ?? 50, 200),
        Number(options.editable ?? false),
        options.accountId ?? null,
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
      mirrorConflict: Boolean(row.mirror_conflict),
      originalDraftLeft: Boolean(row.mirror_left),
    }
  }

  async startCompose(
    input: ComposeStart,
    fetchAttachment: (id: string) => Promise<string | null>,
  ): Promise<ComposeDraft> {
    const thread = input.threadId
      ? (this.#db
          .prepare(
            `SELECT t.account_id, t.subject, m.id, m.from_json, m.sent_at, m.body_text, m.html_blob FROM thread t
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
              html_blob: string | null
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
                  'SELECT id, filename, mime_type, content_id FROM attachment WHERE message_id = ?',
                )
                .all(thread.id) as {
                id: string
                filename: string
                mime_type: string
                content_id: string | null
              }[]
            ).map(async (part) => {
              const blob = await fetchAttachment(part.id)
              const bytes = blob && this.#store.blobs.get(blob)
              if (!blob || !bytes) throw new DraftError(`Could not fetch ${part.filename}`)
              return { ...part, blob, size: bytes.length }
            }),
          )
        : []
    if (forwardParts.reduce((total, part) => total + part.size, 0) > MAX_ATTACHMENT_BYTES) {
      throw new DraftError('Forwarded attachments exceed the 18 MB limit')
    }
    const from = thread?.from_json ? (JSON.parse(thread.from_json) as Address | null) : null
    const attribution =
      thread?.sent_at == null
        ? ''
        : `On ${new Date(thread.sent_at).toISOString().slice(0, 10)}, ${from?.name ?? from?.address ?? 'the sender'} wrote:`
    const originalHtml =
      forward && thread?.html_blob && this.#store.blobs.get(thread.html_blob)?.toString('utf8')
    const forwardHtml = originalHtml
      ? `<p></p><p>${escapeHtml(attribution)}</p><blockquote>${originalHtml}</blockquote>`
      : undefined
    const quote =
      !forwardHtml && thread?.body_text && attribution
        ? [attribution, ...thread.body_text.split('\n').map((line) => `> ${line}`)].join('\n')
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
      { quote, forwardParts, forwardHtml },
    )
    return this.compose(draft.id) as ComposeDraft
  }

  openCompose(id: string): ComposeDraft | null {
    this.#checkEditable(id)
    return this.compose(id)
  }

  replaceComposeBody(id: string, text: string, revision: number, author: string): ComposeDraft {
    const current = this.openCompose(id)
    if (!current) throw new DraftError('Draft does not exist')
    if (revision !== current.revision)
      throw new DraftRevisionConflict(current.body, current.revision)
    if (text === current.body) return current

    const doc = draftDocument(Buffer.from(current.update, 'base64'), current.body)
    const before = Y.encodeStateVector(doc)
    editDraftText(doc, text)
    return this.saveCompose(
      id,
      {
        baseRevision: revision,
        update: Buffer.from(Y.encodeStateAsUpdate(doc, before)).toString('base64'),
      },
      author,
    )
  }

  saveCompose(id: string, patch: ComposePatch, author = 'owner'): ComposeDraft {
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
    let changed = false
    doc.on('update', () => {
      changed = true
    })
    let text: string
    try {
      if (!applyDraftUpdate(doc, Buffer.from(patch.update, 'base64')))
        throw new DraftError(
          'A paragraph changed while you edited it. Copy your unsaved text before reopening the draft.',
          409,
        )
      if (doc.share.size !== 1) throw new Error('Unexpected Yjs fields')
      text = this.#body(row, doc).text
    } catch (error) {
      if (error instanceof DraftError) throw error
      throw new DraftError('Could not apply the document update')
    }
    if (!fields && !changed) return current
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
        this.#queueMirrorRemoval({ ...row, yjs: Y.encodeStateAsUpdate(doc) })
      }
      const signature = current.accountId === accountId ? row.signature : this.signature(accountId)
      this.#db
        .prepare(
          `UPDATE draft SET signature = ?, account_id = ?, to_json = ?, cc_json = ?, bcc_json = ?, subject = ?,
          body_text = ?, yjs = ?, updated_at = ?, last_author = ?, mirror_dirty = 1,
          provider_draft_id = CASE WHEN account_id = ? THEN provider_draft_id ELSE NULL END,
          provider_message_id = CASE WHEN account_id = ? THEN provider_message_id ELSE NULL END,
          mirror_hash = CASE WHEN account_id = ? THEN mirror_hash ELSE NULL END,
          mirror_written_hash = CASE WHEN account_id = ? THEN mirror_written_hash ELSE NULL END
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
          author,
          accountId,
          accountId,
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

  async prepareSend(input: SendRequest, principal: Principal, outbox: Outbox) {
    const id = input.draftId
    return this.#withMirror(id, () => this.#prepareSend(input, principal, outbox))
  }

  async #withMirror<T>(id: string, operation: () => Promise<T>): Promise<T> {
    while (this.#mirror.has(id)) await this.#mirror.get(id)?.catch(() => {})
    const pending = operation().finally(() => this.#mirror.delete(id))
    this.#mirror.set(id, pending)
    return pending
  }

  async #prepareSend(input: SendRequest, principal: Principal, outbox: Outbox) {
    const previous = outbox.replay(principal, input)
    if (previous) return previous
    const id = input.draftId
    if (this.#hasActiveSend(id))
      throw new DraftError('This draft already has a send in the Outbox', 409)
    let message = this.freeze(id, input.revision)
    if (input.edits) {
      const saved = this.saveCompose(id, { ...input.edits, baseRevision: input.revision })
      message = this.freeze(id, saved.revision)
    }
    if (![...message.to, ...message.cc, ...message.bcc].length)
      throw new DraftError('Add a recipient before sending')

    const oldMirrors = this.#db
      .prepare('SELECT * FROM draft_mirror_removal WHERE draft_id = ?')
      .all(id) as unknown as MirrorRemoval[]
    for (const old of oldMirrors) {
      const outcome = await this.#removeOldMirror(old)
      if (outcome === 'changed' || outcome === 'absent') throw new DraftError(MIRROR_CHANGED, 409)
    }
    const row = this.#row(id)
    if (!row || row.modseq !== message.revision) throw new DraftError(DRAFT_CHANGED, 409)
    if (row.provider_draft_id) {
      const api = this.#api(row.account_id)
      if (this.#isImap(row.account_id)) {
        if (!(await this.#removeImapMirror(api, row.provider_draft_id, this.#removalHash(row))))
          this.#markMirrorLeft(id)
      } else {
        if (!api)
          throw new DraftError('Could not remove the provider draft. Sign in again before sending.')
        const remote = api.getDraft ? await api.getDraft(row.provider_draft_id) : undefined
        if (remote === null || (remote && !this.#matchesMirror(row, remote)))
          throw new DraftError(MIRROR_CHANGED, 409)
        this.freeze(id, message.revision)
        if (!(await api.deleteDraft(row.provider_draft_id)))
          throw new DraftError(MIRROR_CHANGED, 409)
      }
      this.#db
        .prepare(`UPDATE draft SET provider_draft_id = NULL, provider_message_id = NULL, mirror_hash = NULL, mirror_written_hash = NULL
        WHERE id = ? AND account_id = ? AND provider_draft_id = ?`)
        .run(id, row.account_id, row.provider_draft_id)
    }
    return outbox.enqueue(principal, input, () => this.freeze(id, message.revision))
  }

  #isImap(accountId: string): boolean {
    return Boolean(
      this.#db.prepare("SELECT 1 FROM account WHERE id = ? AND kind = 'imap'").get(accountId),
    )
  }

  async #removeImapMirror(
    api: DraftMirror | null,
    id: string,
    hash: string | null,
  ): Promise<boolean> {
    return Boolean(api?.imap && hash && (await api.deleteDraft(id, hash)))
  }

  #markMirrorLeft(id: string): void {
    this.#db.prepare('UPDATE draft SET mirror_left = 1 WHERE id = ?').run(id)
  }

  async #removeOldMirror(row: MirrorRemoval): Promise<'removed' | 'changed' | 'left' | 'absent'> {
    const pending = this.#db
      .prepare(`SELECT 1 FROM draft_mirror_removal
        WHERE account_id = ? AND provider_draft_id = ? AND draft_id = ? AND mirror_hash IS ?`)
      .get(row.account_id, row.provider_draft_id, row.draft_id, row.mirror_hash)
    if (!pending) return 'removed'
    const api = this.#api(row.account_id)
    if (this.#isImap(row.account_id)) {
      const removed = await this.#removeImapMirror(api, row.provider_draft_id, row.mirror_hash)
      this.#clearRemoval(row)
      if (!removed) this.#markMirrorLeft(row.draft_id)
      return removed ? 'removed' : 'left'
    }
    if (!api?.getDraft)
      throw new DraftError('Could not remove the provider draft. Sign in again before sending.')
    const remote = await api.getDraft(row.provider_draft_id)
    const changed = remote && row.mirror_hash !== mirrorHash(remote.message.id)
    // Gmail offers no conditional delete. Check the latest message ID before deleting.
    const removed = remote && !changed && (await api.deleteDraft(row.provider_draft_id))
    this.#clearRemoval(row)
    if (
      changed &&
      this.#db.prepare('UPDATE draft SET mirror_conflict = 1 WHERE id = ?').run(row.draft_id)
        .changes
    )
      this.#store.recordChange('draft', row.draft_id, 'upsert')
    return changed ? 'changed' : removed ? 'removed' : 'absent'
  }

  #clearRemoval(row: MirrorRemoval): void {
    this.#db
      .prepare('DELETE FROM draft_mirror_removal WHERE account_id = ? AND provider_draft_id = ?')
      .run(row.account_id, row.provider_draft_id)
  }

  freeze(id: string, revision: number): FrozenMessage {
    const row = this.#row(id)
    if (!row || row.modseq !== revision) throw new DraftError(DRAFT_CHANGED, 409)
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
      .prepare('SELECT * FROM draft_mirror_removal LIMIT 20')
      .all() as unknown as MirrorRemoval[]
    await Promise.allSettled(
      removals.map((row) => this.#withMirror(row.draft_id, () => this.#removeOldMirror(row))),
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

  async pullImap(accountId: string, api: ImapProvider): Promise<void> {
    const known = this.#db
      .prepare('SELECT * FROM draft WHERE account_id = ? AND provider_draft_id IS NOT NULL')
      .all(accountId) as unknown as DraftRow[]
    const knownIds = new Set(known.map((row) => row.provider_draft_id))
    const remote = await api.listDrafts()
    const seen = new Set(remote.map((location) => location.id))
    for (const location of remote) {
      if (
        knownIds.has(location.id) ||
        this.#providerDraft(accountId, location.id) ||
        this.#awaitingRemoval(accountId, location.id) ||
        this.#mirror.size > 0 ||
        location.size > MAX_ATTACHMENT_BYTES * 2
      )
        continue
      const source = await api.readDraft(location)
      if (!source || source.raw.byteLength > MAX_ATTACHMENT_BYTES * 2) continue
      const { raw, structure } = source
      const body: { text?: string; html?: string } = {}
      const incoming = await parseMessage(
        location.folder,
        location.uidValidity,
        { uid: location.uid, seq: 0, size: raw.byteLength },
        this.#store.blobs,
        this.#store.blobs.put(raw),
        body,
      )
      const parts = incoming.attachments.flatMap((part) =>
        part.blob ? [{ ...part, blob: part.blob }] : [],
      )
      this.#importDraft(accountId, location.id, location.id, incoming, parts, undefined, {
        ...body,
        hash: draftSourceHash(raw),
        complete:
          canRepresentMime(structure, parts) &&
          !body.text?.includes('\uFFFD') &&
          !body.html?.includes('\uFFFD'),
      })
    }
    // A new UID can be a replacement or a separate draft. Keep the original local
    // copy bound to its old UID so it cannot be sent as if its mirror still existed.
    for (const local of known) {
      if (!local.provider_draft_id || seen.has(local.provider_draft_id) || local.mirror_conflict)
        continue
      const current = this.#row(local.id)
      if (
        current?.modseq !== local.modseq ||
        current.provider_draft_id !== local.provider_draft_id ||
        this.#mirror.has(local.id) ||
        this.#hasActiveSend(local.id)
      )
        continue
      this.#db.prepare('UPDATE draft SET mirror_conflict = 1 WHERE id = ?').run(local.id)
      if (
        (JSON.parse(local.provider_draft_id) as { endpoint?: string }).endpoint !==
        api.draftEndpoint
      )
        this.#markMirrorLeft(local.id)
    }
  }

  #providerDraft(accountId: string, providerId: string): DraftRow | undefined {
    return this.#db
      .prepare('SELECT * FROM draft WHERE account_id = ? AND provider_draft_id = ?')
      .get(accountId, providerId) as unknown as DraftRow | undefined
  }

  #awaitingRemoval(accountId: string, providerId: string): boolean {
    return Boolean(
      this.#db
        .prepare(
          'SELECT 1 FROM draft_mirror_removal WHERE account_id = ? AND provider_draft_id = ?',
        )
        .get(accountId, providerId),
    )
  }

  async #pullGmailDraft(accountId: string, item: GmailDraft, api: GmailApi): Promise<void> {
    if (this.#awaitingRemoval(accountId, item.id)) return
    const previous = this.#providerDraft(accountId, item.id)
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
    this.#importDraft(accountId, item.id, resource.id, incoming, parts, previous)
  }

  #importDraft(
    accountId: string,
    providerId: string,
    messageId: string,
    incoming: IncomingMessage,
    parts: {
      filename: string
      mimeType: string
      size: number
      blob: string
      contentId: string | null
      inline?: boolean
    }[],
    previous?: DraftRow,
    imap?: Omit<ImapContent, 'editorHtml' | 'editorText'> & { hash: string },
  ): void {
    if (parts.reduce((total, part) => total + part.size, 0) > MAX_ATTACHMENT_BYTES) return
    transaction(this.#db, () => {
      const current = this.#providerDraft(accountId, providerId)
      if (
        previous?.id !== current?.id ||
        previous?.modseq !== current?.modseq ||
        (current && !this.#canImport(current))
      )
        return
      if (!current && (this.#mirror.size > 0 || this.#awaitingRemoval(accountId, providerId)))
        return
      const id = current?.id ?? newId('drf')
      const doc = draftDocument(current?.yjs ?? null, current?.body_text ?? '')
      const sourceText = imap?.text?.replace(/\r\n?/g, '\n') ?? incoming.bodyText
      let complete = imap?.complete ?? true
      let rendered: ReturnType<typeof renderDraft>
      try {
        replaceDraftContent(doc, sourceText, incoming.bodyHtml)
        rendered = renderDraft(doc)
      } catch (error) {
        if (!imap) throw error
        complete = false
        replaceDraftContent(doc, sourceText)
        rendered = renderDraft(doc)
      }
      const text = imap?.text ?? rendered.text
      const imapContent: ImapContent | null = imap
        ? {
            text: imap.text,
            html: imap.html,
            complete,
            editorHtml: rendered.html,
            editorText: rendered.text,
          }
        : null
      const target = `${accountId}:${incoming.providerThreadId}`
      const threadId =
        incoming.inReplyTo && this.#db.prepare('SELECT 1 FROM thread WHERE id = ?').get(target)
          ? target
          : null
      const now = Date.now()
      this.#db
        .prepare(
          `INSERT INTO draft (id, account_id, thread_id, provider_draft_id, provider_message_id,
          to_json, cc_json, bcc_json, subject, body_text, yjs, last_author, updated_at, created_at, in_reply_to, refs, mirror_hash, imap_content, mirror_left)
         VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, 'owner', ?, ?, ?, ?, ?, ?, ?)
         ON CONFLICT (id) DO UPDATE SET thread_id = excluded.thread_id, provider_message_id = excluded.provider_message_id,
          to_json = excluded.to_json, cc_json = excluded.cc_json, bcc_json = excluded.bcc_json, subject = excluded.subject,
          body_text = excluded.body_text, yjs = excluded.yjs, last_author = excluded.last_author, updated_at = excluded.updated_at,
          in_reply_to = excluded.in_reply_to, refs = excluded.refs, mirror_hash = excluded.mirror_hash, quote = '', signature = ''`,
        )
        .run(
          id,
          accountId,
          threadId,
          providerId,
          messageId,
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
          imap?.hash ?? mirrorHash(messageId),
          imapContent ? JSON.stringify(imapContent) : null,
          Number(!complete),
        )
      this.#db.prepare('UPDATE draft_attachment SET active = 0 WHERE draft_id = ?').run(id)
      for (const part of parts) {
        this.#db
          .prepare(
            'INSERT INTO draft_attachment (id, draft_id, filename, mime_type, size, blob, content_id, disposition) VALUES (?, ?, ?, ?, ?, ?, ?, ?)',
          )
          .run(
            newId('att'),
            id,
            part.filename || 'attachment',
            part.mimeType,
            part.size,
            part.blob,
            imap || (part.contentId && incoming.bodyHtml?.includes(`cid:${part.contentId}`))
              ? part.contentId
              : null,
            imap ? (part.inline ? 'inline' : 'attachment') : null,
          )
      }
      this.#store.recordChange('draft', id, 'upsert')
    })
  }

  #canImport(row: DraftRow): boolean {
    return !row.mirror_dirty && !this.#mirror.has(row.id) && !this.#hasActiveSend(row.id)
  }

  #matchesMirror(row: DraftRow, remote: GmailDraft): boolean {
    const baseline =
      row.mirror_hash ?? (row.provider_message_id && mirrorHash(row.provider_message_id))
    return baseline === mirrorHash(remote.message.id)
  }

  #queueMirrorRemoval(row: DraftRow) {
    this.#db
      .prepare('INSERT OR IGNORE INTO draft_mirror_removal VALUES (?, ?, ?, ?)')
      .run(row.account_id, row.provider_draft_id, this.#removalHash(row), row.id)
  }

  #removalHash(row: DraftRow): string | null {
    if (!this.#isImap(row.account_id))
      return row.mirror_hash ?? (row.provider_message_id && mirrorHash(row.provider_message_id))
    return this.#canReplaceContent(row) ? row.mirror_hash : null
  }

  #canReplaceContent(row: DraftRow): boolean {
    if (!row.imap_content) return true
    const body = JSON.parse(row.imap_content) as ImapContent
    if (!body.complete) return false
    if (!body.html) return true
    const editor = renderDraft(draftDocument(row.yjs, row.body_text)).html
    return (
      editor === body.editorHtml ||
      (body.html.replace(/\r?\n$/, '') === body.editorHtml &&
        (body.text === undefined ||
          body.text.replace(/\r\n/g, '\n').replace(/\n$/, '') === body.editorText))
    )
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
        'SELECT id, filename, mime_type AS mimeType, size, blob, content_id AS contentId, disposition FROM draft_attachment WHERE draft_id = ? AND (? = 0 OR active = 1) ORDER BY rowid',
      )
      .all(id, +active) as unknown as AttachmentRow[]
  }

  #body(row: DraftRow, doc = draftDocument(row.yjs, row.body_text)) {
    const original = row.imap_content ? (JSON.parse(row.imap_content) as ImapContent) : null
    const rendered = renderDraft(doc, original && !original.html ? '\n' : undefined)
    if (!original || rendered.html !== original.editorHtml)
      return { ...rendered, editorHtml: rendered.html }
    return { text: original.text ?? '', html: original.html ?? '', editorHtml: rendered.html }
  }

  #message(row: DraftRow): FrozenMessage {
    const { text, html, editorHtml } = this.#body(row)
    const displaysInline = (part: AttachmentRow) => {
      const src = `src="cid:${part.contentId}"`
      return !!part.contentId && (editorHtml.includes(src) || html.includes(src))
    }
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
      ...(row.mirror_left ? { originalDraftLeft: true } : {}),
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
        .filter((part) => part.disposition || !part.contentId || displaysInline(part))
        .map((part) => {
          const bytes = this.#store.blobs.get(part.blob)
          if (!bytes) throw new DraftError(`Attachment ${part.filename} is unavailable`)
          return {
            filename: part.filename,
            mimeType: part.mimeType,
            content: bytes.toString('base64'),
            contentId: part.contentId ?? undefined,
            contentDisposition:
              part.disposition && part.contentId && !displaysInline(part)
                ? 'attachment'
                : (part.disposition ?? undefined),
          }
        }),
    }
  }

  async create(
    input: DraftInput,
    author: string,
    compose?: {
      quote: string
      forwardHtml?: string
      forwardParts: {
        filename: string
        mime_type: string
        content_id: string | null
        size: number
        blob: string
      }[]
    },
  ): Promise<VersionedDraft> {
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
    const doc = draftDocument(null, input.body ?? '')
    if (compose?.forwardHtml) replaceDraftContent(doc, '', compose.forwardHtml)
    const { text: body, html } = compose?.forwardHtml
      ? renderDraft(doc)
      : { text: input.body ?? '', html: '' }
    const signature = compose ? this.signature(accountId) : ''
    const state = Y.encodeStateAsUpdate(doc)

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
          .run(
            newId('att'),
            id,
            part.filename,
            part.mime_type,
            part.size,
            part.blob,
            part.content_id && html.includes(`src="cid:${part.content_id}"`)
              ? part.content_id
              : null,
          )
      }
      this.#store.recordChange('draft', id, 'upsert')
    })
    if (!compose) await this.#push(id)
    return this.get(id) as VersionedDraft
  }

  async update(
    id: string,
    patch: Omit<DraftInput, 'threadId' | 'accountId' | 'replyAll'>,
    author: string,
    agentRevision?: number,
  ): Promise<VersionedDraft> {
    const row = this.#row(id)
    if (!row) throw new DraftError(`No draft ${id}`)
    this.#checkEditable(id)
    const doc = draftDocument(row.yjs, row.body_text)
    if (patch.body !== undefined) {
      if (agentRevision === undefined) replaceDraftContent(doc, patch.body)
      else {
        if (agentRevision !== row.modseq) throw new DraftRevisionConflict(row.body_text, row.modseq)
        if (patch.body !== row.body_text) editDraftText(doc, patch.body)
      }
    }
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
    return this.get(id) as VersionedDraft
  }

  async delete(id: string): Promise<DiscardDraftResult> {
    return this.#withMirror(id, async () => {
      this.#checkEditable(id)
      const row = this.#row(id)
      if (!row) return { absent: id }
      const pending = this.#db
        .prepare('SELECT DISTINCT account_id FROM draft_mirror_removal WHERE draft_id = ?')
        .all(id) as { account_id: string }[]
      const provider = this.#isImap(row.account_id) ? 'IMAP' : 'Gmail'
      const removal: MirrorRemoval | null =
        row.provider_draft_id && row.mirror_written_hash
          ? {
              account_id: row.account_id,
              provider_draft_id: row.provider_draft_id,
              mirror_hash: row.mirror_written_hash,
              draft_id: id,
            }
          : null
      transaction(this.#db, () => {
        // Earlier cleanup may refer to imported revisions. Discard only the copy AMC wrote.
        this.#db.prepare('DELETE FROM draft_mirror_removal WHERE draft_id = ?').run(id)
        if (removal)
          this.#db
            .prepare('INSERT INTO draft_mirror_removal VALUES (?, ?, ?, ?)')
            .run(removal.account_id, removal.provider_draft_id, removal.mirror_hash, id)
        this.#db.prepare('DELETE FROM draft WHERE id = ?').run(id)
        this.#store.recordChange('draft', id, 'delete')
      })

      const kept = new Set(
        pending.map(({ account_id }) => (this.#isImap(account_id) ? 'IMAP' : 'Gmail')),
      )
      if (row.mirror_left) kept.add('IMAP')
      if (row.provider_draft_id && !removal) kept.add(provider)
      let providerRemoved: 'Gmail' | 'IMAP' | undefined
      let retry = false
      if (removal) {
        try {
          const outcome = await this.#removeOldMirror(removal)
          if (outcome === 'removed' || outcome === 'absent') providerRemoved = provider
          else kept.add(provider)
        } catch {
          retry = true
        }
      }

      const warnings = [...kept].map((name) => `A copy in ${name} was left untouched.`)
      if (retry) warnings.push(`AMC will retry removing the copy in ${provider}.`)
      return {
        deleted: id,
        ...(providerRemoved && { providerRemoved }),
        ...(warnings.length > 0 && { warning: warnings.join(' ') }),
      }
    })
  }

  #push(id: string): Promise<void> {
    const existing = this.#mirror.get(id)
    if (existing) return existing.then(() => {})
    const pending = this.#pushOnce(id).finally(() => this.#mirror.delete(id))
    this.#mirror.set(id, pending)
    return pending
  }

  async #pushOnce(id: string): Promise<void> {
    const row = this.#row(id)
    if (!row || this.#hasActiveSend(id)) return
    try {
      const api = this.#api(row.account_id)
      if (!api) throw new Error('Account is unavailable')
      if (api.imap && row.provider_draft_id && !this.#canReplaceContent(row)) {
        this.#db.prepare('UPDATE draft SET mirror_left = 1, mirror_dirty = 0 WHERE id = ?').run(id)
        return
      }
      const message = this.#message(row)
      const raw = await buildMessage(message)
      const providerThread = message.threadId?.slice(row.account_id.length + 1)
      const previous = row.provider_draft_id
      const remote = previous && api.getDraft ? await api.getDraft(previous) : undefined
      if (remote === null) throw new DraftError(MIRROR_CHANGED, 409)
      const diverged = remote && !this.#matchesMirror(row, remote)
      const saved = await api.saveDraft({
        draftId: diverged ? undefined : (previous ?? undefined),
        raw,
        threadId: providerThread,
      })
      const savedHash = saved.sourceHash ?? mirrorHash(saved.message.id)
      transaction(this.#db, () => {
        const updated = this.#db
          .prepare(
            `UPDATE draft SET provider_draft_id = ?, provider_message_id = ?, mirror_hash = ?, mirror_written_hash = ?, mirror_error = 0,
             mirror_conflict = MAX(mirror_conflict, ?),
             mirror_dirty = CASE WHEN modseq = ? THEN 0 ELSE 1 END WHERE id = ? AND account_id = ? AND provider_draft_id IS ?`,
          )
          .run(
            saved.id,
            saved.message.id,
            savedHash,
            savedHash,
            Number(Boolean(diverged)),
            row.modseq,
            id,
            row.account_id,
            previous,
          )
        if (!updated.changes) {
          this.#queueMirrorRemoval({
            ...row,
            provider_draft_id: saved.id,
            mirror_hash: savedHash,
            imap_content: null,
          })
        } else if (previous && previous !== saved.id && remote === undefined) {
          this.#queueMirrorRemoval(row)
        }
      })
    } catch {
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

  #toDraft(r: DraftRow): VersionedDraft {
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
      revision: r.modseq,
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
