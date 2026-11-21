import type { FetchMessageObject, MailboxObject } from 'imapflow'
import type { MailStore } from '../../mail/store.ts'
import type { ImapClient } from './client.ts'
import {
  type Folder,
  mapFolders,
  messageFlags,
  messagePrefix,
  parseMessage,
  providerMessageId,
} from './mapping.ts'
import { ImapThreads } from './threading.ts'

interface FolderCursor {
  path: string
  validity: string
  highUid: number
  modseq: string | null
  before: number
}

interface PendingPage {
  validity: string
  uids: number[]
}

const PAGE = 32
const SOURCE_BATCH = 8

/** Owns a single connection. All IMAP commands are serialized, including SELECT and FETCH. */
export class ImapAccountSync {
  readonly #client: ImapClient
  readonly #store: MailStore
  readonly #accountId: string
  readonly #address: string
  readonly #threads: ImapThreads
  readonly #cursor: Map<string, FolderCursor>
  readonly #pending = new Map<string, PendingPage>()
  #folders: Folder[] = []
  #inboxSnapshot: { exists: number; uidNext: number; highestModseq: bigint | undefined } | undefined
  #inboxChanged = false
  #wake: (() => void) | undefined

  constructor(client: ImapClient, store: MailStore, accountId: string, address: string) {
    this.#client = client
    this.#store = store
    this.#accountId = accountId
    this.#address = address
    this.#threads = new ImapThreads(store, accountId)
    const row = store.db.prepare('SELECT cursor FROM account WHERE id = ?').get(accountId) as {
      cursor: string
    }
    const saved = JSON.parse(row.cursor) as { folders?: FolderCursor[] }
    this.#cursor = new Map(saved.folders?.map((folder) => [folder.path, folder]))
    const changed = ({ path, earlier }: { path: string; earlier?: boolean | undefined }) => {
      if (path !== 'INBOX' || earlier) return
      this.#inboxChanged = true
      this.#wake?.()
    }
    client.on('exists', changed).on('flags', changed).on('expunge', changed)
    client.on('close', () => this.#wake?.())
  }

  get inboxChanged(): boolean {
    return this.#inboxChanged
  }

  async step(mode: 'all' | 'inbox' | 'backfill'): Promise<boolean> {
    if (mode !== 'backfill') this.#inboxChanged = false
    if (mode === 'all') await this.#listFolders()
    for (const folder of this.#folders) {
      if (mode === 'inbox' && folder.path !== 'INBOX') continue
      if (mode === 'backfill' && !this.#cursor.get(folder.path)?.before) continue
      await this.#syncFolder(folder, mode !== 'backfill')
    }
    const done = !this.#folders.some((folder) => this.#cursor.get(folder.path)?.before)
    const { count } = this.#store.db
      .prepare('SELECT count(*) AS count FROM message WHERE account_id = ?')
      .get(this.#accountId) as { count: number }
    const progress = JSON.stringify({ phase: done ? 'done' : 'all', fetched: count })
    const updated = this.#store.db
      .prepare('UPDATE account SET backfill = ? WHERE id = ? AND backfill != ?')
      .run(progress, this.#accountId, progress)
    if (updated.changes) this.#store.recordChange('account', this.#accountId, 'upsert')
    return done
  }

  async waitForInbox(ms: number, signal: AbortSignal): Promise<void> {
    if (signal.aborted || this.#inboxChanged || !this.#client.usable) return
    const selected = this.#client.mailbox
    if (!selected || selected.path !== 'INBOX') {
      // ImapFlow enters IDLE automatically after SELECT when the connection is quiet.
      const box = await this.#client.mailboxOpen('INBOX', { readOnly: true })
      const previous = this.#inboxSnapshot
      if (
        previous &&
        (box.exists !== previous.exists ||
          box.uidNext !== previous.uidNext ||
          box.highestModseq !== previous.highestModseq ||
          String(box.uidValidity) !== this.#cursor.get('INBOX')?.validity)
      )
        this.#inboxChanged = true
    }
    if (signal.aborted || this.#inboxChanged || !this.#client.usable) return
    await new Promise<void>((resolve) => {
      const wake = () => {
        clearTimeout(timer)
        signal.removeEventListener('abort', wake)
        this.#wake = undefined
        resolve()
      }
      const timer = setTimeout(wake, ms)
      signal.addEventListener('abort', wake, { once: true })
      this.#wake = wake
    })
  }

  async #listFolders(): Promise<void> {
    this.#folders = mapFolders(await this.#client.list())
    if (!this.#folders.some((folder) => folder.path === 'INBOX')) {
      throw new Error('The IMAP server did not list INBOX')
    }
    const paths = new Set(this.#folders.map((folder) => folder.path))
    for (const path of this.#cursor.keys()) {
      if (paths.has(path)) continue
      this.#clearFolder(path)
      this.#cursor.delete(path)
      this.#pending.delete(path)
    }
    this.#saveCursor()
    this.#store.syncLabels(
      this.#accountId,
      this.#folders.map((folder) => folder.label),
    )
  }

  #saveCursor(): void {
    const json = JSON.stringify({ folders: [...this.#cursor.values()] })
    this.#store.db
      .prepare('UPDATE account SET cursor = ? WHERE id = ? AND cursor != ?')
      .run(json, this.#accountId, json)
  }

  #storedIds(prefix: string): { provider_id: string }[] {
    // The ASCII separator terminates the escaped path, and the range can use the compound index.
    const end = `${prefix.slice(0, -1)};`
    return this.#store.db
      .prepare(
        'SELECT provider_id FROM message WHERE account_id = ? AND provider_id >= ? AND provider_id < ?',
      )
      .all(this.#accountId, prefix, end) as { provider_id: string }[]
  }

  #clearFolder(path: string): void {
    for (const { provider_id } of this.#storedIds(messagePrefix(path))) {
      this.#store.deleteMessage(this.#accountId, provider_id)
    }
  }

  async #syncFolder(folder: Folder, reconcile: boolean): Promise<void> {
    const { path } = folder
    const box = await this.#client.mailboxOpen(path, { readOnly: true })
    if (!box.uidValidity || !Number.isSafeInteger(box.uidNext) || box.uidNext < 1) {
      throw new Error('IMAP SELECT lacks UIDVALIDITY or UIDNEXT')
    }
    if (path === 'INBOX') {
      this.#inboxSnapshot = {
        exists: box.exists,
        uidNext: box.uidNext,
        highestModseq: box.highestModseq,
      }
    }
    const validity = String(box.uidValidity)
    const highUid = box.uidNext - 1
    const modseq = this.#modseq(box)
    const old = this.#cursor.get(path)
    let cursor = old
    if (!cursor || cursor.validity !== validity) {
      this.#clearFolder(path)
      this.#pending.delete(path)
      cursor = { path, validity, highUid, modseq, before: box.exists ? box.uidNext : 0 }
      // Persist the reset before fetching so an interrupted first page can retry idempotently.
      this.#cursor.set(path, cursor)
      this.#saveCursor()
    } else if (reconcile) {
      await this.#reconcile(folder, cursor, box, modseq)
    }

    if (cursor.highUid < highUid) {
      const uids = await this.#search(`${cursor.highUid + 1}:${highUid}`)
      for (let i = 0; i < uids.length; i += PAGE) {
        await this.#fetchMessages(folder, validity, uids.slice(i, i + PAGE))
      }
    }
    if (cursor.before) await this.#backfill(folder, cursor)
    this.#cursor.set(path, { ...cursor, highUid, modseq: reconcile ? modseq : cursor.modseq })
    this.#saveCursor()
  }

  #modseq(box: MailboxObject): string | null {
    return !box.noModseq && this.#client.enabled.has('CONDSTORE') && box.highestModseq
      ? String(box.highestModseq)
      : null
  }

  async #search(range?: string): Promise<number[]> {
    const uids = await this.#client.search(range ? { uid: range } : { all: true }, { uid: true })
    if (!uids) throw new Error('IMAP UID SEARCH failed')
    return uids.sort((a, b) => a - b)
  }

  async #backfill(folder: Folder, cursor: FolderCursor): Promise<void> {
    let pending = this.#pending.get(folder.path)
    if (!pending || pending.validity !== cursor.validity) {
      const uids = cursor.before > 1 ? await this.#search(`1:${cursor.before - 1}`) : []
      pending = { validity: cursor.validity, uids }
      this.#pending.set(folder.path, pending)
    }
    const page = pending.uids.slice(-PAGE).reverse()
    await this.#fetchMessages(folder, cursor.validity, page)
    pending.uids.splice(-PAGE)
    cursor.before = pending.uids.length ? (page.at(-1) ?? 0) : 0
    if (!cursor.before) this.#pending.delete(folder.path)
  }

  async #fetchMessages(folder: Folder, validity: string, uids: number[]): Promise<void> {
    const missing = uids.filter(
      (uid) =>
        !this.#store.hasMessage(this.#accountId, providerMessageId(folder.path, validity, uid)),
    )
    // A UID set is returned in server order. Buffer a small batch to ingest newest first.
    for (let i = 0; i < missing.length; i += SOURCE_BATCH) {
      const batch = missing.slice(i, i + SOURCE_BATCH)
      const messages = new Map<number, FetchMessageObject>()
      for await (const item of this.#client.fetch(
        batch,
        { source: true, flags: true, internalDate: true },
        { uid: true },
      )) {
        messages.set(item.uid, item)
      }
      for (const uid of batch) {
        const item = messages.get(uid)
        if (!item) continue
        const message = await parseMessage(folder, validity, item)
        message.providerThreadId = this.#threads.assign(message)
        this.#store.putMessage(this.#accountId, [this.#address], message)
      }
    }
  }

  async #reconcile(
    folder: Folder,
    cursor: FolderCursor,
    box: MailboxObject,
    modseq: string | null,
  ) {
    const id = (uid: number) => providerMessageId(folder.path, cursor.validity, uid)
    const delta =
      modseq && cursor.modseq && BigInt(modseq) >= BigInt(cursor.modseq)
        ? BigInt(cursor.modseq)
        : null
    const removed = new Set<number>()
    if (box.exists && delta) {
      if (modseq !== cursor.modseq) {
        const expunge = (event: { path: string; uid?: number | undefined }) => {
          if (event.path === folder.path && event.uid !== undefined) removed.add(event.uid)
        }
        this.#client.on('expunge', expunge)
        try {
          // With QRESYNC enabled ImapFlow adds VANISHED to this UID FETCH.
          for await (const item of this.#client.fetch(
            '1:*',
            { flags: true },
            { uid: true, changedSince: delta },
          )) {
            this.#store.setMessageFlags(this.#accountId, id(item.uid), messageFlags(item.flags))
          }
        } finally {
          this.#client.off('expunge', expunge)
        }
      }
      if (this.#client.enabled.has('QRESYNC')) {
        for (const uid of removed) this.#store.deleteMessage(this.#accountId, id(uid))
        return
      }
    }

    const present = new Set(box.exists ? await this.#search() : [])
    const retained = new Set<number>()
    for (const { provider_id } of this.#storedIds(
      `${messagePrefix(folder.path)}${cursor.validity}:`,
    )) {
      const uid = Number(provider_id.slice(provider_id.lastIndexOf(':') + 1))
      if (present.has(uid)) retained.add(uid)
      else this.#store.deleteMessage(this.#accountId, provider_id)
    }
    if (delta || !retained.size) return
    for await (const item of this.#client.fetch('1:*', { flags: true }, { uid: true })) {
      if (retained.has(item.uid)) {
        this.#store.setMessageFlags(this.#accountId, id(item.uid), messageFlags(item.flags))
      }
    }
  }
}
