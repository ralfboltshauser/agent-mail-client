import { EventEmitter } from 'node:events'
import { Readable } from 'node:stream'
import type {
  DownloadOptions,
  FetchMessageObject,
  FetchOptions,
  FetchQueryObject,
  ListResponse,
  MailboxObject,
  MessageStructureObject,
  SearchObject,
} from 'imapflow'
import type { ImapClient } from './client.ts'

interface FakeMessage {
  source: Buffer
  flags: Set<string>
  modseq: bigint
  emailId?: string
  structure?: MessageStructureObject
  parts?: Map<string, Buffer>
}

class FakeFolder {
  readonly messages = new Map<number, FakeMessage>()
  readonly removed = new Map<number, bigint>()
  validity = 1n
  nextUid = 1
  modseq = 1n
  path: string
  specialUse: string | undefined
  mailboxId?: string

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
  readonly searches: { path: string; uids: number[] }[] = []
  readonly downloads: { path: string; uid: number; part: string | undefined }[] = []
  readonly idles: string[] = []
  onSearch?: (path: string) => void
  onDownload?: (path: string, uid: number, part: string | undefined) => void
  onIdle?: (path: string) => void
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

  renameFolder(old: string, path: string): void {
    const folder = this.folder(old)
    this.folders.delete(old)
    folder.path = path
    this.folders.set(path, folder)
  }

  async idle(): Promise<void> {
    if (!this.mailbox) return
    this.idles.push(this.mailbox.path)
    this.onIdle?.(this.mailbox.path)
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
      mailboxId: selected.mailboxId,
      highestModseq: this.enabled.has('CONDSTORE') ? selected.modseq : undefined,
      delimiter: '/',
      flags: new Set(),
    }
    return this.mailbox
  }

  async search(query: SearchObject): Promise<number[]> {
    const selected = this.#selected
    if (!selected) throw new Error('No selected test folder')
    const uids =
      typeof query.seq === 'string'
        ? [...selected.messages.keys()].slice(Number(query.seq) - 1, Number(query.seq))
        : this.#uids(selected, typeof query.uid === 'string' ? query.uid : '1:*')
    this.searches.push({ path: selected.path, uids })
    this.onSearch?.(selected.path)
    return uids
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
        if (modseq > since && this.#inRange(selected, range, uid))
          this.emit('expunge', { path: selected.path, uid, vanished: true, earlier: true })
      }
    }
    for (const uid of uids) {
      const item = selected.messages.get(uid)
      if (item && item.modseq > since) {
        const headerEnd = item.source.indexOf('\r\n\r\n')
        const headers = item.source.subarray(0, headerEnd + 4)
        const envelope = query.envelope ? headers.toString() : undefined
        yield {
          uid,
          seq: uid,
          flags: item.flags,
          size: query.size ? item.source.length : undefined,
          headers: query.headers ? headers : undefined,
          envelope:
            envelope === undefined
              ? undefined
              : {
                  subject: envelope.match(/^Subject: ([^\r\n]*)/im)?.[1],
                  messageId: envelope.match(/^Message-ID: ([^\r\n]*)/im)?.[1],
                },
          bodyStructure: query.bodyStructure ? item.structure : undefined,
          emailId: query.emailId ? item.emailId : undefined,
          source: query.source ? item.source : undefined,
        }
      }
    }
  }

  async messageDelete(range: string): Promise<boolean> {
    return this.#selected?.messages.delete(Number(range)) ?? false
  }

  async append(
    folder: string,
    raw: Buffer,
    flags: string[],
  ): Promise<{ path: string; uid: number; uidValidity: bigint } | false> {
    if (this.failAppend) return false
    this.appended.push({ folder, raw, flags })
    const target = this.folder(folder)
    const uid = target.nextUid++
    target.messages.set(uid, { source: raw, flags: new Set(flags), modseq: ++target.modseq })
    return { path: folder, uid, uidValidity: target.validity }
  }

  async download(range: string, part: string | undefined, options: DownloadOptions) {
    if (this.failFetch) throw new Error('Fake FETCH failed')
    if (!this.#selected || !options.uid) throw new Error('Expected UID download in selected folder')
    const uid = Number(range)
    this.downloads.push({ path: this.#selected.path, uid, part })
    this.onDownload?.(this.#selected.path, uid, part)
    const item = this.#selected.messages.get(uid)
    const bytes = part ? item?.parts?.get(part) : item?.source
    if (!bytes) return {}
    const size = Math.min(bytes.length, options.maxBytes ?? Infinity)
    return {
      content: Readable.from(
        (function* () {
          for (let start = 0; start < size; start += 4096)
            yield bytes.subarray(start, Math.min(start + 4096, size))
        })(),
      ),
    }
  }

  #inRange(folder: FakeFolder, range: string | number[], uid: number): boolean {
    if (Array.isArray(range)) return range.includes(uid)
    const largest = [...folder.messages.keys()].at(-1) ?? 0
    return range.split(',').some((part) => {
      const [first, last = first] = part.split(':')
      const start = first === '*' ? largest : Number(first)
      const end = last === '*' ? largest : Number(last)
      return uid >= Math.min(start, end) && uid <= Math.max(start, end)
    })
  }

  #uids(folder: FakeFolder, range: string | number[]): number[] {
    return [...folder.messages.keys()]
      .filter((uid) => this.#inRange(folder, range, uid))
      .sort((a, b) => a - b)
  }
}
