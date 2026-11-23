import type { FetchMessageObject, MailboxObject, SearchObject } from 'imapflow'
import { transaction } from '../../db/database.ts'
import type { MailStore } from '../../mail/store.ts'
import { advanceMailboxGeneration } from '../../mail/triage/annotations.ts'
import { type ImapClient, imapMoveSupport } from './client.ts'
import { ImapLocations, PAGE } from './locations.ts'
import { type Folder, mapFolders, messageFlags, parseMessage } from './mapping.ts'

const RECONCILE_PAGE = 512
const INBOX_WINDOW_INTERVAL = 1000
const IDLE_FINISH_TIMEOUT_MS = 5_000

export class ImapSyncFailure extends Error {
  readonly phase: string
  readonly folder: string | null
  readonly summary: string

  constructor(phase: string, folder: string | null, summary: string, cause?: unknown) {
    super(cause instanceof Error ? cause.message : summary, { cause })
    this.phase = phase
    this.folder = folder
    this.summary = summary
  }
}

export class ImapIdleFailure extends ImapSyncFailure {
  constructor(summary: string, cause?: unknown) {
    super('idle', 'INBOX', summary, cause)
  }
}

async function imapOperation<T>(
  phase: string,
  folder: string | null,
  summary: string,
  run: () => Promise<T>,
): Promise<T> {
  try {
    return await run()
  } catch (error) {
    if (error instanceof ImapSyncFailure) throw error
    throw new ImapSyncFailure(phase, folder, summary, error)
  }
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
  readonly locations: ImapLocations
  readonly #cursor: Map<string, FolderCursor>
  #folders: Folder[] = []
  #moveSupport: boolean | undefined
  #organise: (() => Promise<void>) | undefined
  #cancelOrganise: (() => void) | undefined
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
    this.locations = new ImapLocations(store, accountId, address)
    const row = store.db.prepare('SELECT cursor FROM account WHERE id = ?').get(accountId) as {
      cursor: string
    }
    const saved = JSON.parse(row.cursor) as { folders?: FolderCursor[]; imapMoves?: boolean }
    this.#moveSupport = saved.imapMoves
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

  queueOrganise(work: (sync: ImapAccountSync) => Promise<void>): Promise<boolean> {
    if (!this.client.usable || this.#organise) return Promise.resolve(false)
    return new Promise((resolve, reject) => {
      this.#cancelOrganise = () => resolve(false)
      this.#organise = async () => {
        try {
          await work(this)
          resolve(true)
        } catch (error) {
          reject(error)
        }
      }
      this.#wake?.()
    })
  }

  async runQueuedOrganise(): Promise<boolean> {
    const work = this.#organise
    if (!work) return false
    this.#organise = undefined
    this.#cancelOrganise = undefined
    await work()
    return true
  }

  async refreshOrganiseFolder(folder: Folder): Promise<void> {
    await this.#syncFolderWithContext(folder, true)
  }

  dispose(): void {
    this.#cancelOrganise?.()
    this.#organise = undefined
    this.#cancelOrganise = undefined
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
    if (mode === 'all') {
      await imapOperation('list', null, 'Could not refresh the folder list', () =>
        this.#listFolders(),
      )
    }
    let processed = false
    for (const folder of this.#folders) {
      if (mode === 'inbox' && folder.path !== 'INBOX') continue
      if (mode === 'backfill' && !this.#cursor.get(folder.path)?.before) continue
      if (processed || (mode === 'backfill' && folder.path !== 'INBOX')) await serviceInbox?.()
      await this.#syncFolderWithContext(folder, mode !== 'backfill', serviceInbox)
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

  async waitForInbox(ms: number, signal: AbortSignal, wakeSignal?: AbortSignal): Promise<number> {
    const waiting = wakeSignal ? AbortSignal.any([signal, wakeSignal]) : signal
    if (waiting.aborted || this.#inboxChanged || this.#organise || !this.client.usable) return 0
    const selected = this.client.mailbox
    if (!selected || selected.path !== 'INBOX') {
      const box = await this.#openFolder('INBOX')
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
    if (waiting.aborted || this.#inboxChanged || this.#organise || !this.client.usable) return 0

    const start = Date.now()
    let wake: () => void = () => {}
    const pause = new Promise<void>((resolve) => {
      wake = () => {
        clearTimeout(timer)
        waiting.removeEventListener('abort', wake)
        this.#wake = undefined
        resolve()
      }
      const timer = setTimeout(wake, ms)
      waiting.addEventListener('abort', wake, { once: true })
      this.#wake = wake
    })
    let pending = true
    const idle = this.client.idle({ whenFree: true }).then(
      (result) => {
        pending = false
        if (result === false) throw new ImapIdleFailure('Server did not accept IDLE')
      },
      (error: unknown) => {
        pending = false
        throw new ImapIdleFailure('IDLE failed', error)
      },
    )
    try {
      await Promise.race([pause, idle.then(() => pause)])
      if (pending && !signal.aborted && this.client.usable) {
        // The next mailbox command would otherwise wait behind IDLE with the socket timeout.
        // NOOP makes ImapFlow send DONE. Bound that handshake before opening another folder.
        let timer: ReturnType<typeof setTimeout> | undefined
        try {
          await Promise.race([
            Promise.all([idle, this.client.noop()]),
            new Promise<never>((_, reject) => {
              timer = setTimeout(
                () => reject(new ImapIdleFailure('Server did not finish IDLE')),
                IDLE_FINISH_TIMEOUT_MS,
              )
            }),
          ])
        } catch (error) {
          if (error instanceof ImapIdleFailure) throw error
          throw new ImapIdleFailure('Could not finish IDLE', error)
        } finally {
          clearTimeout(timer)
        }
      } else if (!pending) {
        await idle
      }
      return Date.now() - start
    } finally {
      wake()
    }
  }

  #openFolder(path: string): Promise<MailboxObject> {
    return imapOperation('select', path, 'Could not open the folder', () =>
      this.client.mailboxOpen(path, { readOnly: true }),
    )
  }

  async #listFolders(): Promise<void> {
    const folders = mapFolders(await this.client.list())
    if (!folders.some((folder) => folder.path === 'INBOX')) {
      throw new ImapSyncFailure('list', 'INBOX', 'Server did not list INBOX')
    }
    const paths = new Set(folders.map((folder) => folder.path))
    const missing = [...this.#cursor.values()].filter(({ path }) => !paths.has(path))
    const renames = new Map<string, Folder>()
    const identifiable = missing.filter(({ mailboxId }) => mailboxId)
    if (identifiable.length) {
      const candidates = new Map<string, Folder[]>()
      const matchCounts = new Map<string, number>()
      for (const folder of folders) {
        if (this.#cursor.has(folder.path)) continue
        const box = await this.#openFolder(folder.path)
        if (!box.mailboxId) continue
        for (const old of identifiable) {
          if (old.mailboxId === box.mailboxId && old.validity === String(box.uidValidity)) {
            candidates.set(old.path, [...(candidates.get(old.path) ?? []), folder])
            matchCounts.set(folder.path, (matchCounts.get(folder.path) ?? 0) + 1)
          }
        }
      }
      for (const [path, matches] of candidates) {
        const [folder] = matches
        if (matches.length === 1 && folder && matchCounts.get(folder.path) === 1) {
          renames.set(path, folder)
        }
      }
    }

    this.#folders = folders
    transaction(this.store.db, () => {
      this.store.syncLabels(
        this.accountId,
        folders.map(({ label }) => label),
      )
      for (const old of missing) {
        const renamed = renames.get(old.path)
        if (renamed) {
          this.locations.relabel(old.path, renamed)
          this.#cursor.set(renamed.path, { ...old, path: renamed.path })
        } else {
          this.locations.clear(old.path)
        }
        this.#cursor.delete(old.path)
      }
      for (const folder of folders) this.locations.relabel(folder.path, folder)
      const moves = imapMoveSupport(this.client).available
      const changed = moves !== this.#moveSupport
      this.#moveSupport = moves
      this.#saveCursor()
      if (changed) this.store.recordChange('account', this.accountId, 'upsert')
    })
  }

  #saveCursor(next?: FolderCursor): void {
    const folders = [...this.#cursor.values()].filter(({ path }) => path !== next?.path)
    if (next) folders.push(next)
    const json = JSON.stringify({
      folders,
      imapMoves: this.#moveSupport,
      imapTrashLabels: this.#folders
        .filter(({ trash }) => trash)
        .map(({ label }) => label.providerId),
    })
    this.store.db
      .prepare('UPDATE account SET cursor = ? WHERE id = ? AND cursor != ?')
      .run(json, this.accountId, json)
  }

  #syncFolderWithContext(
    folder: Folder,
    reconcile: boolean,
    serviceInbox?: () => Promise<void>,
  ): Promise<void> {
    return imapOperation('folder', folder.path, 'Could not sync the folder', () =>
      this.#syncFolder(folder, reconcile, serviceInbox),
    )
  }

  async #syncFolder(
    folder: Folder,
    reconcile: boolean,
    serviceInbox?: () => Promise<void>,
  ): Promise<void> {
    const { path } = folder
    const box = await this.#openFolder(path)
    if (!box.uidValidity || !Number.isSafeInteger(box.uidNext) || box.uidNext < 1) {
      throw new ImapSyncFailure('select', path, 'Server omitted UIDVALIDITY or UIDNEXT')
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
      const current = await this.#openFolder(path)
      if (String(current.uidValidity) !== validity || current.mailboxId !== box.mailboxId) {
        throw new ImapSyncFailure(
          'reconcile',
          path,
          'Mailbox identity changed during reconciliation',
        )
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
      const identityChanged = !!cursor
      cursor = {
        path,
        validity,
        mailboxId: box.mailboxId,
        highUid,
        modseq,
        before: box.exists ? box.uidNext : 0,
      }
      const reset = cursor
      transaction(this.store.db, () => {
        if (identityChanged) advanceMailboxGeneration(this.store.db, this.accountId)
        this.locations.clear(path, true)
        this.#saveCursor(reset)
      })
      this.#cursor.set(path, reset)
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
    const next = {
      ...cursor,
      mailboxId: box.mailboxId ?? cursor.mailboxId,
      highUid,
      before: box.exists && before > 1 ? before : 0,
      modseq: reconcile ? modseq : cursor.modseq,
    }
    transaction(this.store.db, () => {
      if (!next.before) this.locations.finishReimport(path)
      this.#saveCursor(next)
    })
    this.#cursor.set(path, next)
  }

  async #search(query: SearchObject): Promise<number[]> {
    const mailbox = this.client.mailbox
    const path = mailbox ? mailbox.path : null
    return imapOperation('search', path, 'UID SEARCH failed', async () => {
      const uids = await this.client.search(query, { uid: true })
      if (!uids) throw new Error('IMAP UID SEARCH failed')
      return uids.sort((a, b) => a - b)
    })
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
      if (this.locations.get(folder.path, validity, uid)?.verified) continue
      const item = await imapOperation(
        'fetch',
        folder.path,
        'Could not fetch message metadata',
        () => this.#metadata(uid),
      )
      if (!item) continue
      const source = await imapOperation(
        'download',
        folder.path,
        'Could not download message source',
        () => this.#downloadSource(uid, item.size),
      )
      const message = await imapOperation(
        'parse',
        folder.path,
        'Could not parse message source',
        () => parseMessage(folder, validity, item, this.store.blobs, source),
      )
      this.locations.put(folder, validity, item, message, source)
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
      const rows = this.locations.page(path, validity, after, RECONCILE_PAGE)
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
        if (!remote.has(uid)) this.locations.remove(path, validity, uid)
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
          this.locations.flags(path, validity, item.uid, unread, starred)
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
