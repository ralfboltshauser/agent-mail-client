import type { FetchMessageObject, MailboxObject, SearchObject } from 'imapflow'
import { transaction } from '../../db/database.ts'
import type { MailStore } from '../../mail/store.ts'
import type { ImapClient } from './client.ts'
import { ImapLocations, PAGE } from './locations.ts'
import { type Folder, mapFolders, messageFlags, parseMessage } from './mapping.ts'

const RECONCILE_PAGE = 512
const INBOX_WINDOW_INTERVAL = 1000

interface FolderCursor {
  path: string
  validity: string
  mailboxId?: string | undefined
  highUid: number
  exists?: number
  modseq: string | null
  before: number
}

/** Owns a single connection. Inbox IDLE and other folders alternate at page boundaries. */
export class ImapAccountSync {
  readonly #locations: ImapLocations
  readonly #cursor: Map<string, FolderCursor>
  #folders: Folder[] = []
  #inboxSnapshot: { exists: number; uidNext: number; highestModseq: bigint | undefined } | undefined
  #inboxChanged = false
  #sequenceEpoch = 0
  #wake: (() => void) | undefined

  readonly client: ImapClient
  readonly store: MailStore
  readonly accountId: string

  constructor(client: ImapClient, store: MailStore, accountId: string, address: string) {
    this.client = client
    this.store = store
    this.accountId = accountId
    this.#locations = new ImapLocations(store, accountId, address)
    const row = store.db.prepare('SELECT cursor FROM account WHERE id = ?').get(accountId) as {
      cursor: string
    }
    const saved = JSON.parse(row.cursor) as { folders?: FolderCursor[] }
    this.#cursor = new Map(saved.folders?.map((folder) => [folder.path, folder]))
    client.on('exists', this.#changed).on('flags', this.#changed).on('expunge', this.#changed)
    client.on('close', this.#closed)
  }

  #changed = ({ path, earlier }: { path: string; earlier?: boolean | undefined }) => {
    if (earlier) return
    this.#sequenceEpoch++
    if (path !== 'INBOX') return
    this.#inboxChanged = true
    this.#wake?.()
  }

  #closed = () => this.#wake?.()

  dispose(): void {
    this.client
      .off('exists', this.#changed)
      .off('flags', this.#changed)
      .off('expunge', this.#changed)
    this.client.off('close', this.#closed)
  }

  get inboxChanged(): boolean {
    return this.#inboxChanged
  }

  async step(
    mode: 'all' | 'inbox' | 'backfill',
    serviceInbox?: () => Promise<void>,
  ): Promise<boolean> {
    if (mode !== 'backfill') this.#inboxChanged = false
    if (mode === 'all') await this.#listFolders()
    let processed = false
    for (const folder of this.#folders) {
      if (mode === 'inbox' && folder.path !== 'INBOX') continue
      if (mode === 'backfill' && !this.#cursor.get(folder.path)?.before) continue
      if (processed || (mode === 'backfill' && folder.path !== 'INBOX')) await serviceInbox?.()
      await this.#syncFolder(folder, mode !== 'backfill', serviceInbox)
      processed = true
    }
    const done = !this.#folders.some((folder) => this.#cursor.get(folder.path)?.before)
    const { count } = this.store.db
      .prepare('SELECT count(*) AS count FROM message WHERE account_id = ?')
      .get(this.accountId) as { count: number }
    const progress = JSON.stringify({ phase: done ? 'done' : 'all', fetched: count })
    const updated = this.store.db
      .prepare('UPDATE account SET backfill = ? WHERE id = ? AND backfill != ?')
      .run(progress, this.accountId, progress)
    if (updated.changes) this.store.recordChange('account', this.accountId, 'upsert')
    return done
  }

  async waitForInbox(ms: number, signal: AbortSignal): Promise<number> {
    if (signal.aborted || this.#inboxChanged || !this.client.usable) return 0
    const selected = this.client.mailbox
    if (!selected || selected.path !== 'INBOX') {
      const box = await this.client.mailboxOpen('INBOX', { readOnly: true })
      const previous = this.#inboxSnapshot
      if (
        previous &&
        (box.exists !== previous.exists ||
          box.uidNext !== previous.uidNext ||
          box.highestModseq !== previous.highestModseq ||
          String(box.uidValidity) !== this.#cursor.get('INBOX')?.validity)
      ) {
        this.#inboxChanged = true
      }
    }
    if (signal.aborted || this.#inboxChanged || !this.client.usable) return 0

    const start = Date.now()
    await new Promise<void>((resolve, reject) => {
      const wake = () => {
        clearTimeout(timer)
        signal.removeEventListener('abort', wake)
        this.#wake = undefined
        resolve()
      }
      const timer = setTimeout(wake, ms)
      signal.addEventListener('abort', wake, { once: true })
      this.#wake = wake
      // IDLE stays active until the next command. Attach a rejection handler even when the
      // timer or an Inbox event wakes the runner before that command ends the IDLE.
      void this.client.idle({ whenFree: true }).then(
        (result) => {
          if (result === false && this.#wake === wake) {
            reject(new Error('IMAP IDLE failed'))
            wake()
          }
        },
        (error: Error) => {
          if (this.#wake === wake) {
            reject(error)
            wake()
          }
        },
      )
    })
    return Date.now() - start
  }

  async #listFolders(): Promise<void> {
    const folders = mapFolders(await this.client.list())
    if (!folders.some((folder) => folder.path === 'INBOX')) {
      throw new Error('The IMAP server did not list INBOX')
    }
    const paths = new Set(folders.map((folder) => folder.path))
    const missing = [...this.#cursor.values()].filter(({ path }) => !paths.has(path))
    const renames = new Map<string, Folder>()
    if (missing.length) {
      const candidates = new Map<string, Folder[]>()
      for (const folder of folders) {
        if (this.#cursor.has(folder.path)) continue
        const box = await this.client.mailboxOpen(folder.path, { readOnly: true })
        const matches: FolderCursor[] = []
        for (const old of missing) {
          if (old.validity !== String(box.uidValidity)) continue
          const same =
            old.mailboxId && box.mailboxId
              ? old.mailboxId === box.mailboxId
              : await this.#matchesCachedFolder(old, box)
          if (same) matches.push(old)
        }
        const match = matches.length === 1 ? matches[0] : undefined
        if (match) {
          candidates.set(match.path, [...(candidates.get(match.path) ?? []), folder])
        }
      }
      for (const [path, matches] of candidates) {
        if (matches.length === 1 && matches[0]) renames.set(path, matches[0])
      }
    }

    transaction(this.store.db, () => {
      this.store.syncLabels(
        this.accountId,
        folders.map(({ label }) => label),
      )
      for (const old of missing) {
        const renamed = renames.get(old.path)
        if (renamed) {
          this.#locations.relabel(old.path, renamed)
          this.#cursor.set(renamed.path, { ...old, path: renamed.path })
        } else {
          this.#locations.clear(old.path)
        }
        this.#cursor.delete(old.path)
      }
      for (const folder of folders) this.#locations.relabel(folder.path, folder)
      this.#saveCursor()
    })
    this.#folders = folders
  }

  // A unique UIDVALIDITY/UIDNEXT/count match can identify a rename without OBJECTID.
  // Older checkpoints lack the count. For those and for changed folders, check
  // overlapping cached UIDs against their content or the legacy Message-ID.
  async #matchesCachedFolder(old: FolderCursor, box: MailboxObject): Promise<boolean> {
    if (box.uidNext === old.highUid + 1) {
      const count =
        old.exists ??
        (old.before === 0
          ? this.store.db
              .prepare(
                'SELECT count(*) AS count FROM imap_location WHERE account_id = ? AND path_key = ? AND validity = ?',
              )
              .get(this.accountId, encodeURIComponent(old.path), old.validity)?.count
          : undefined)
      if (box.exists === count) return true
    }
    if (!box.exists || box.uidNext <= old.highUid) return false
    const rows = this.#locations.page(old.path, old.validity)
    if (!rows.length) return false
    const remote = new Set(await this.#search({ uid: rows.map(({ uid }) => uid).join(',') }))
    let matched = false
    for (const { uid, message_id, source_blob } of rows) {
      if (!remote.has(uid)) continue
      if (source_blob) {
        if ((await this.#downloadSource(uid)) !== source_blob) return false
      } else {
        const local = this.store.db
          .prepare('SELECT rfc_message_id FROM message WHERE id = ?')
          .get(message_id)?.rfc_message_id
        if (typeof local !== 'string') continue
        const headers = (await this.#metadata(uid))?.headers?.toString()
        if (headers?.match(/^Message-ID:[ \t]*(?:\r?\n[ \t]+)?([^\r\n]+)/im)?.[1]?.trim() !== local)
          return false
      }
      matched = true
    }
    return matched
  }

  #saveCursor(): void {
    const json = JSON.stringify({ folders: [...this.#cursor.values()] })
    this.store.db
      .prepare('UPDATE account SET cursor = ? WHERE id = ? AND cursor != ?')
      .run(json, this.accountId, json)
  }

  async #syncFolder(
    folder: Folder,
    reconcile: boolean,
    serviceInbox?: () => Promise<void>,
  ): Promise<void> {
    const { path } = folder
    const box = await this.client.mailboxOpen(path, { readOnly: true })
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
    let lastInboxWindow = performance.now()
    const yieldToInbox = async () => {
      if (path === 'INBOX' || !serviceInbox) return
      if (performance.now() - lastInboxWindow < INBOX_WINDOW_INTERVAL) return
      await serviceInbox()
      const current = await this.client.mailboxOpen(path, { readOnly: true })
      if (String(current.uidValidity) !== validity || current.mailboxId !== box.mailboxId) {
        throw new Error('IMAP mailbox identity changed during reconciliation')
      }
      lastInboxWindow = performance.now()
    }
    const highUid = box.uidNext - 1
    const modseq =
      !box.noModseq && this.client.enabled.has('CONDSTORE') && box.highestModseq
        ? String(box.highestModseq)
        : null
    let cursor = this.#cursor.get(path)
    if (
      !cursor ||
      cursor.validity !== validity ||
      (cursor.mailboxId && box.mailboxId && cursor.mailboxId !== box.mailboxId)
    ) {
      this.#locations.clear(path)
      cursor = {
        path,
        validity,
        mailboxId: box.mailboxId,
        highUid,
        exists: box.exists,
        modseq,
        before: box.exists ? box.uidNext : 0,
      }
      this.#cursor.set(path, cursor)
      this.#saveCursor()
    } else if (reconcile) {
      await this.#reconcile(folder, cursor, box, modseq, yieldToInbox)
    }

    for (let before = highUid + 1; before > cursor.highUid + 1 && box.exists; ) {
      const page = await this.#pageBefore(cursor.highUid + 1, before)
      await this.#fetchMessages(folder, validity, page.uids)
      before = page.before
      await yieldToInbox()
    }
    let before = cursor.before
    if (before > 1 && box.exists) {
      const page = await this.#pageBefore(1, before)
      await this.#fetchMessages(folder, validity, page.uids.reverse())
      before = page.before
    }
    this.#cursor.set(path, {
      ...cursor,
      mailboxId: box.mailboxId ?? cursor.mailboxId,
      highUid,
      exists: box.exists,
      before: box.exists && before > 1 ? before : 0,
      modseq: reconcile ? modseq : cursor.modseq,
    })
    this.#saveCursor()
  }

  async #search(query: SearchObject): Promise<number[]> {
    const uids = await this.client.search(query, { uid: true })
    if (!uids) throw new Error('IMAP UID SEARCH failed')
    return uids.sort((a, b) => a - b)
  }

  async #pageBefore(minimum: number, before: number): Promise<{ uids: number[]; before: number }> {
    let end = before - 1
    while (end >= minimum) {
      const start = Math.max(minimum, end - PAGE + 1)
      const uids = await this.#search({ uid: `${start}:${end}` })
      if (uids.length || start === minimum) return { uids, before: start }

      // UIDs are sparse after expunges. Search by sequence position to jump across an
      // empty UID range without ever returning an unbounded list of UIDs.
      const epoch = this.#sequenceEpoch
      let low = 1
      let high = this.client.mailbox ? this.client.mailbox.exists : 0
      let last = 0
      while (low <= high) {
        const middle = Math.floor((low + high) / 2)
        const [uid] = await this.#search({ seq: String(middle) })
        if (uid === undefined || uid >= start) high = middle - 1
        else {
          last = uid
          low = middle + 1
        }
      }
      if (this.#sequenceEpoch !== epoch)
        throw new Error('IMAP sequence numbers changed while paging')
      end = last
    }
    return { uids: [], before: minimum }
  }

  async #metadata(uid: number) {
    let item: FetchMessageObject | undefined
    for await (const row of this.client.fetch(
      [uid],
      {
        size: true,
        flags: true,
        internalDate: true,
        bodyStructure: true,
        headers: [
          'From',
          'To',
          'Cc',
          'Bcc',
          'Reply-To',
          'Subject',
          'Date',
          'Message-ID',
          'References',
          'In-Reply-To',
          'List-Unsubscribe',
        ],
        emailId: true,
      },
      { uid: true },
    ))
      item = row
    return item
  }

  async #downloadSource(uid: number, expectedSize?: number): Promise<string> {
    const { content, meta } = await this.client.download(String(uid), undefined, { uid: true })
    if (!content) throw new Error('IMAP source disappeared during download')
    const { hash } = await this.store.blobs.putStream(content, expectedSize ?? meta?.expectedSize)
    return hash
  }

  async #fetchMessages(folder: Folder, validity: string, uids: number[]): Promise<void> {
    for (const uid of uids) {
      if (this.#locations.get(folder.path, validity, uid)?.verified) continue
      const item = await this.#metadata(uid)
      if (!item) continue
      const source = await this.#downloadSource(uid, item.size)
      const { message, fingerprint } = await parseMessage(
        folder,
        validity,
        item,
        this.store.blobs,
        source,
      )
      this.#locations.put(folder, validity, uid, message, fingerprint, source)
    }
  }

  async #reconcile(
    folder: Folder,
    cursor: FolderCursor,
    box: MailboxObject,
    modseq: string | null,
    yieldToInbox: () => Promise<void>,
  ) {
    const { path } = folder
    const { validity } = cursor
    const delta =
      modseq && cursor.modseq && BigInt(modseq) >= BigInt(cursor.modseq)
        ? BigInt(cursor.modseq)
        : null
    let after = 0
    for (;;) {
      const rows = this.#locations.page(path, validity, after, RECONCILE_PAGE)
      if (!rows.length) return
      after = rows[rows.length - 1]?.uid ?? after
      // SEARCH is authoritative even when QRESYNC's VANISHED is limited to the FETCH
      // set or an expunged UID is higher than the last extant UID.
      const remote = new Set(
        box.exists ? await this.#search({ uid: rows.map(({ uid }) => uid).join(',') }) : [],
      )
      const present: number[] = []
      const legacy: number[] = []
      for (const { uid, verified } of rows) {
        if (!remote.has(uid)) this.#locations.remove(path, validity, uid)
        else if (!verified) legacy.push(uid)
        else present.push(uid)
      }
      if (present.length && (!delta || modseq !== cursor.modseq)) {
        for await (const item of this.client.fetch(
          present,
          { flags: true },
          delta ? { uid: true, changedSince: delta } : { uid: true },
        )) {
          const { unread, starred } = messageFlags(item.flags)
          this.#locations.flags(path, validity, item.uid, unread, starred)
        }
      }
      await yieldToInbox()
      for (let start = 0; start < legacy.length; start += PAGE) {
        await this.#fetchMessages(folder, validity, legacy.slice(start, start + PAGE))
        await yieldToInbox()
      }
    }
  }
}
