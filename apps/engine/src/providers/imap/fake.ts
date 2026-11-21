import { EventEmitter } from 'node:events'
import type {
  FetchMessageObject,
  FetchOptions,
  FetchQueryObject,
  ListResponse,
  MailboxObject,
  SearchObject,
} from 'imapflow'
import type { ImapClient } from './client.ts'

interface FakeMessage {
  source: Buffer
  flags: Set<string>
  modseq: bigint
}

class FakeFolder {
  readonly messages = new Map<number, FakeMessage>()
  readonly removed = new Map<number, bigint>()
  validity = 1n
  nextUid = 1
  modseq = 1n
  readonly path: string
  readonly specialUse: string | undefined

  constructor(path: string, specialUse?: string) {
    this.path = path
    this.specialUse = specialUse
  }
}

export class FakeImap extends EventEmitter {
  readonly folders = new Map<string, FakeFolder>()
  readonly enabled: Set<string>
  readonly capabilities = new Map<string, boolean | number>()
  readonly requests: {
    path: string
    source: boolean
    uids: number[]
    changedSince?: bigint | string | number | undefined
  }[] = []
  readonly appended: { folder: string; raw: Buffer; flags: string[] }[] = []
  usable = false
  mailbox: MailboxObject | false = false
  failAppend = false
  failFetch = false
  #selected: FakeFolder | undefined

  constructor(extensions: string[] = []) {
    super()
    this.enabled = new Set(extensions)
    this.addFolder('INBOX')
  }

  get client(): ImapClient {
    // The fake implements only the IMAP operations and overloads used by the provider.
    return this as unknown as ImapClient
  }

  addFolder(path: string, specialUse?: string): FakeFolder {
    const folder = new FakeFolder(path, specialUse)
    this.folders.set(path, folder)
    return folder
  }

  add(path: string, headers: string, body = 'Test message', flags: string[] = []): number {
    const folder = this.folder(path)
    const uid = folder.nextUid++
    folder.messages.set(uid, {
      source: Buffer.from(
        `From: sender@example.com\r\nTo: owner@example.com\r\nDate: Sat, 21 Nov 2026 10:00:00 +0000\r\n${headers}\r\n\r\n${body}`,
      ),
      flags: new Set(flags),
      modseq: ++folder.modseq,
    })
    if (this.mailbox && this.mailbox.path === path) this.emit('exists', { path })
    return uid
  }

  flag(path: string, uid: number, flags: string[]): void {
    const folder = this.folder(path)
    const item = folder.messages.get(uid)
    if (!item) throw new Error('No such test message')
    item.flags = new Set(flags)
    item.modseq = ++folder.modseq
    if (this.mailbox && this.mailbox.path === path)
      this.emit('flags', { path, uid, flags: item.flags })
  }

  expunge(path: string, uid: number): void {
    const folder = this.folder(path)
    folder.messages.delete(uid)
    folder.removed.set(uid, ++folder.modseq)
    if (this.mailbox && this.mailbox.path === path) this.emit('expunge', { path, uid })
  }

  folder(path: string): FakeFolder {
    const folder = this.folders.get(path)
    if (!folder) throw new Error('No such test folder')
    return folder
  }

  async connect(): Promise<void> {
    this.usable = true
  }

  close(): void {
    this.usable = false
    this.mailbox = false
    this.emit('close')
  }

  async list(): Promise<Partial<ListResponse>[]> {
    return [...this.folders.values()].map(({ path, specialUse }) => ({
      path,
      specialUse,
      flags: new Set(),
    }))
  }

  async mailboxOpen(path: string): Promise<MailboxObject> {
    const selected = this.folder(path)
    this.#selected = selected
    this.mailbox = {
      path,
      exists: selected.messages.size,
      uidNext: selected.nextUid,
      uidValidity: selected.validity,
      highestModseq: this.enabled.has('CONDSTORE') ? selected.modseq : undefined,
      delimiter: '/',
      flags: new Set(),
    }
    return this.mailbox
  }

  async search(query: SearchObject): Promise<number[]> {
    const selected = this.#selected
    if (!selected) throw new Error('No selected test folder')
    return this.#uids(selected, typeof query.uid === 'string' ? query.uid : '1:*')
  }

  async *fetch(
    range: string | number[],
    query: FetchQueryObject,
    options: FetchOptions,
  ): AsyncGenerator<FetchMessageObject> {
    const selected = this.#selected
    if (!selected || !options.uid) throw new Error('Expected a UID FETCH in a selected folder')
    const uids = this.#uids(selected, range)
    const since = BigInt(options.changedSince ?? 0)
    this.requests.push({
      path: selected.path,
      source: !!query.source,
      uids,
      changedSince: options.changedSince,
    })
    if (this.failFetch) throw new Error('Fake FETCH failed')
    if (since && this.enabled.has('QRESYNC')) {
      for (const [uid, modseq] of selected.removed) {
        if (modseq > since)
          this.emit('expunge', { path: selected.path, uid, vanished: true, earlier: true })
      }
    }
    for (const uid of uids) {
      const item = selected.messages.get(uid)
      if (item && item.modseq > since) {
        yield { uid, seq: uid, flags: item.flags, source: query.source ? item.source : undefined }
      }
    }
  }

  async append(folder: string, raw: Buffer, flags: string[]): Promise<{ path: string } | false> {
    if (this.failAppend) return false
    this.appended.push({ folder, raw, flags })
    return { path: folder }
  }

  #uids(folder: FakeFolder, range: string | number[]): number[] {
    const [lo, hi] = typeof range === 'string' ? range.split(':') : []
    const end = hi === '*' ? Number.POSITIVE_INFINITY : Number(hi ?? lo)
    return [...folder.messages.keys()]
      .filter((uid) =>
        Array.isArray(range) ? range.includes(uid) : uid >= Number(lo) && uid <= end,
      )
      .sort((a, b) => a - b)
  }
}
