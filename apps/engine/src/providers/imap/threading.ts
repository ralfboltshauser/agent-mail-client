import type { IncomingMessage, MailStore } from '../../mail/store.ts'

type ThreadHeaders = Pick<
  IncomingMessage,
  'providerId' | 'rfcMessageId' | 'references' | 'inReplyTo' | 'subject' | 'sentAt'
>

const SUBJECT_WINDOW_MS = 7 * 24 * 60 * 60 * 1000

function ids(header: string | null): string[] {
  if (!header) return []
  const bracketed = [...header.matchAll(/<([^<>\s]+@[^<>\s]+)>/g)].map((match) => match[1] ?? '')
  if (bracketed.length) return bracketed
  return header
    .trim()
    .split(/\s+/)
    .filter((id) => /^[^<>\s]+@[^<>\s]+$/.test(id))
}

/** Reference containers include missing ancestors. Finding a new link can join existing Threads. */
export class ImapThreads {
  readonly #store: MailStore
  readonly #accountId: string
  readonly #aliases = new Map<string, string>()
  readonly #parents = new Map<string, string>()
  readonly #subjects = new Map<
    string,
    { thread: string; sentAt: number; reply: boolean; hasParent: boolean }[]
  >()

  constructor(store: MailStore, accountId: string) {
    this.#store = store
    this.#accountId = accountId
    const rows = store.db
      .prepare(
        `SELECT m.provider_id AS providerId, m.rfc_message_id AS rfcMessageId, m.refs AS "references",
                m.in_reply_to AS inReplyTo, m.subject, m.sent_at AS sentAt,
                t.provider_thread_id AS providerThreadId
         FROM message m JOIN thread t ON t.id = m.thread_id WHERE m.account_id = ?`,
      )
      .iterate(accountId) as unknown as Iterable<ThreadHeaders & { providerThreadId: string }>
    // Materialize the query before slotting rows into a graph that can merge existing Threads.
    for (const row of [...rows]) this.#assign(row, row.providerThreadId)
  }

  assign(message: ThreadHeaders): string {
    return this.#assign(message)
  }

  #root(thread: string): string {
    let root = thread
    let parent = this.#parents.get(root)
    while (parent !== undefined) {
      root = parent
      parent = this.#parents.get(root)
    }
    if (root !== thread) this.#parents.set(thread, root)
    return root
  }

  #assign(message: ThreadHeaders, persisted?: string): string {
    const own = ids(message.rfcMessageId)[0]
    const references = ids(message.references)
    const parent = references.length ? references : ids(message.inReplyTo).slice(0, 1)
    const keys = [...new Set([...parent, ...(own ? [own] : [])])]
    const known = keys.flatMap((key) => {
      const thread = this.#aliases.get(key)
      return thread ? [this.#root(thread)] : []
    })
    const reply = /^\s*re\s*:/i.test(message.subject)
    const subject = message.subject
      .replace(/^(\s*re\s*:\s*)+/i, '')
      .trim()
      .toLowerCase()
    const peers = subject ? (this.#subjects.get(subject) ?? []) : []
    const hasParent = parent.some((key) => key !== own)
    let nearby: string | undefined
    if (!persisted && !known.length && !hasParent && message.sentAt > 0) {
      let closest = SUBJECT_WINDOW_MS
      for (const peer of peers) {
        if ((!reply && (!peer.reply || peer.hasParent)) || !peer.sentAt) continue
        const distance = Math.abs(message.sentAt - peer.sentAt)
        if (distance >= closest) continue
        closest = distance
        nearby = this.#root(peer.thread)
      }
    }

    const canonical = persisted ? this.#root(persisted) : nearby
    const thread =
      known[0] ??
      canonical ??
      (keys[0] ? `imap:${encodeURIComponent(keys[0])}` : `imap:local:${message.providerId}`)
    for (const candidate of new Set([...known, ...(canonical ? [canonical] : [])])) {
      if (candidate === thread) continue
      this.#store.mergeThreads(this.#accountId, candidate, thread)
      this.#parents.set(candidate, thread)
    }
    for (const key of keys) this.#aliases.set(key, thread)
    if (subject) {
      peers.push({ thread, sentAt: message.sentAt, reply, hasParent })
      this.#subjects.set(subject, peers)
    }
    return thread
  }
}
