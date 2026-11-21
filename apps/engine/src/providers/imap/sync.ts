import type { FetchMessageObject, MailboxObject, SearchObject } from 'imapflow'
import { transaction } from '../../db/database.ts'
import type { MailStore } from '../../mail/store.ts'
import type { ImapClient } from './client.ts'
import { ImapLocations, PAGE } from './locations.ts'
import {
  type Folder,
  largePreview,
  MESSAGE_LIMIT,
  mapFolders,
  messageFlags,
  parseMessage,
} from './mapping.ts'

interface FolderRename {
  folder: Folder
  identified: boolean
}

interface FolderCursor {
  path: string
  validity: string
  mailboxId?: string | undefined
  highUid: number
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
    betweenFolders?: () => Promise<void>,
  ): Promise<boolean> {
    if (mode !== 'backfill') this.#inboxChanged = false
    if (mode === 'all') await this.#listFolders()
    let processed = false
    for (const folder of this.#folders) {
      if (mode === 'inbox' && folder.path !== 'INBOX') continue
      if (mode === 'backfill' && !this.#cursor.get(folder.path)?.before) continue
      if (processed || (mode === 'backfill' && folder.path !== 'INBOX')) await betweenFolders?.()
      await this.#syncFolder(folder, mode !== 'backfill')
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
    const renames = new Map<string, FolderRename>()
    if (missing.length) {
      const candidates = new Map<string, FolderRename[]>()
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
          candidates.set(match.path, [
            ...(candidates.get(match.path) ?? []),
            { folder, identified: Boolean(match.mailboxId && box.mailboxId) },
          ])
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
          const { folder, identified } = renamed
          this.#locations.relabel(old.path, folder)
          this.#cursor.set(folder.path, {
            ...old,
            path: folder.path,
            // Matching bytes protect cached messages. Only a stable server mailbox ID
            // also proves that the previous folder's UID and MODSEQ checkpoints apply.
            before: identified ? old.before : old.highUid + 1,
            modseq: identified ? old.modseq : null,
          })
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

  // Base IMAP has no stable mailbox identifier. Require byte-for-byte evidence for
  // every cached UID still present at the candidate path before transferring its cursor.
  async #matchesCachedFolder(old: FolderCursor, box: MailboxObject): Promise<boolean> {
    if (!box.exists || box.uidNext <= old.highUid) return false
    let after = 0
    let matched = false
    for (;;) {
      const rows = this.#locations.page(old.path, old.validity, after)
      if (!rows.length) return matched
      const remote = new Set(await this.#search({ uid: rows.map(({ uid }) => uid).join(',') }))
      for (const { uid, source_blob } of rows) {
        if (!remote.has(uid)) continue
        if (!source_blob) return false
        const item = await this.#metadata(uid)
        if (!item || item.size === undefined || item.size > MESSAGE_LIMIT) return false
        if ((await this.#downloadSource(uid)) !== source_blob) return false
        matched = true
      }
      after = rows[rows.length - 1]?.uid ?? after
    }
  }

  #saveCursor(): void {
    const json = JSON.stringify({ folders: [...this.#cursor.values()] })
    this.store.db
      .prepare('UPDATE account SET cursor = ? WHERE id = ? AND cursor != ?')
      .run(json, this.accountId, json)
  }

  async #syncFolder(folder: Folder, reconcile: boolean): Promise<void> {
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
        modseq,
        before: box.exists ? box.uidNext : 0,
      }
      this.#cursor.set(path, cursor)
      this.#saveCursor()
    } else if (reconcile) {
      await this.#reconcile(folder, cursor, box, modseq)
    }

    for (let before = highUid + 1; before > cursor.highUid + 1 && box.exists; ) {
      const page = await this.#pageBefore(cursor.highUid + 1, before)
      await this.#fetchMessages(folder, validity, page.uids)
      before = page.before
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

  async #downloadSource(uid: number): Promise<string> {
    const { content } = await this.client.download(String(uid), undefined, {
      uid: true,
      maxBytes: MESSAGE_LIMIT + 1,
    })
    if (!content) throw new Error('IMAP source disappeared during download')
    return (await this.store.blobs.putStream(content, MESSAGE_LIMIT)).hash
  }

  async #fetchMessages(folder: Folder, validity: string, uids: number[]): Promise<void> {
    for (const uid of uids) {
      if (this.#locations.get(folder.path, validity, uid)?.verified) continue
      const item = await this.#metadata(uid)
      if (!item) continue
      const source =
        item.size !== undefined && item.size <= MESSAGE_LIMIT
          ? await this.#downloadSource(uid)
          : null
      const preview = source ? undefined : await largePreview(this.client, item)
      const message = await parseMessage(folder, validity, item, this.store.blobs, source, preview)
      // ImapFlow synthesizes its fallback "id" from a folder and UID. Only emailId
      // from the server can identify an oversized copy without downloading it.
      const fingerprint = source ?? (item.emailId ? `email-id:${item.emailId}` : null)
      this.#locations.put(folder, validity, uid, message, fingerprint, source)
    }
  }

  async #reconcile(
    folder: Folder,
    cursor: FolderCursor,
    box: MailboxObject,
    modseq: string | null,
  ) {
    const { path } = folder
    const { validity } = cursor
    const delta =
      modseq && cursor.modseq && BigInt(modseq) >= BigInt(cursor.modseq)
        ? BigInt(cursor.modseq)
        : null
    let after = 0
    for (;;) {
      const rows = this.#locations.page(path, validity, after)
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
      await this.#fetchMessages(folder, validity, legacy)
    }
  }
}
