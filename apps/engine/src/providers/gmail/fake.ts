import { GmailHttpError } from './http.ts'
import type {
  GmailApi,
  GmailDraft,
  GmailHistoryList,
  GmailHistoryRecord,
  GmailLabel,
  GmailMessage,
  GmailMessageState,
  GmailProfile,
} from './types.ts'

export type FakeGmailWrite =
  | { kind: 'batch'; ids: string[]; add: string[]; remove: string[] }
  | { kind: 'trash'; ids: [string]; trashed: boolean }

/** An in-memory Gmail for tests: messages, labels and a history log with expiry. */
export class FakeGmail implements GmailApi {
  address = 'owner@example.com'
  messages = new Map<string, GmailMessage>()
  labelList: GmailLabel[] = [
    { id: 'INBOX', name: 'INBOX', type: 'system' },
    { id: 'UNREAD', name: 'UNREAD', type: 'system' },
    { id: 'STARRED', name: 'STARRED', type: 'system' },
    { id: 'SENT', name: 'SENT', type: 'system' },
  ]
  #history: GmailHistoryRecord[] = []
  #historyId = 1000
  readonly lastWriter = new Map<
    string,
    Map<string, { writer: 'owner' | 'amc'; revision: number }>
  >()
  /** History older than this id is "expired" (Gmail answers 404). */
  oldestHistory = 0
  historyPageSize = 500
  calls = { getMessage: 0, list: 0 }
  trashFailure: { afterWrite: boolean; error: Error } | undefined
  batchFailure: { applied: number; error: Error } | undefined
  afterThreadRead: (() => void) | undefined
  onRead: ((snapshot: ReadonlyMap<string, readonly string[]>) => void) | undefined
  beforeWrite: ((write: FakeGmailWrite) => void) | undefined
  beforeAmcLabelChange: ((id: string, label: string, present: boolean) => void) | undefined
  afterLabelRead: (() => Promise<void>) | undefined

  add(
    id: string,
    opts: {
      threadId?: string
      labels?: string[]
      subject?: string
      from?: string
      body?: string
      date?: number
    } = {},
  ) {
    const message: GmailMessage = {
      id,
      threadId: opts.threadId ?? `t-${id}`,
      labelIds: opts.labels ?? ['INBOX', 'UNREAD'],
      snippet: opts.body?.slice(0, 50) ?? '',
      internalDate: String(opts.date ?? Number(id.replace(/\D/g, '') || 1) * 1000),
      sizeEstimate: 100,
      payload: {
        mimeType: 'text/plain',
        headers: [
          { name: 'From', value: opts.from ?? 'Alice <alice@example.com>' },
          { name: 'To', value: this.address },
          { name: 'Subject', value: opts.subject ?? `Subject ${id}` },
          { name: 'Message-ID', value: `<${id}@example.com>` },
        ],
        body: { size: 10, data: Buffer.from(opts.body ?? `Body of ${id}`).toString('base64url') },
      },
    }
    this.messages.set(id, message)
    this.lastWriter.set(
      id,
      new Map(
        (message.labelIds ?? []).map((label) => [
          label,
          { writer: 'owner', revision: this.#historyId + 7 },
        ]),
      ),
    )
    this.#record({
      messagesAdded: [{ message: { id, threadId: message.threadId, labelIds: message.labelIds } }],
    })
    message.historyId = String(this.#historyId)
    return message
  }

  setLabels(id: string, labels: string[]) {
    this.#setLabels(id, labels, 'owner')
  }

  #setLabels(id: string, labels: string[], writer: 'owner' | 'amc') {
    const message = this.messages.get(id)
    if (!message) throw new Error(`no message ${id}`)
    const previous = message.labelIds ?? []
    const added = labels.filter((label) => !previous.includes(label))
    const removed = previous.filter((label) => !labels.includes(label))
    if (!added.length && !removed.length) return
    if (writer === 'amc') {
      for (const label of added) this.beforeAmcLabelChange?.(id, label, true)
      for (const label of removed) this.beforeAmcLabelChange?.(id, label, false)
    }
    message.labelIds = labels
    const reference = { id, threadId: message.threadId }
    this.#record({
      ...(added.length ? { labelsAdded: [{ message: reference, labelIds: added }] } : {}),
      ...(removed.length ? { labelsRemoved: [{ message: reference, labelIds: removed }] } : {}),
    })
    message.historyId = String(this.#historyId)
    const writers = this.lastWriter.get(id)
    for (const label of [...added, ...removed])
      writers?.set(label, { writer, revision: this.#historyId })
  }

  remove(id: string) {
    const m = this.messages.get(id)
    this.messages.delete(id)
    this.lastWriter.delete(id)
    if (m) this.#record({ messagesDeleted: [{ message: { id, threadId: m.threadId } }] })
  }

  #record(record: Omit<GmailHistoryRecord, 'id'>) {
    this.#historyId += 7
    this.#history.push({ id: String(this.#historyId), ...record })
  }

  async profile(): Promise<GmailProfile> {
    return {
      emailAddress: this.address,
      messagesTotal: this.messages.size,
      threadsTotal: this.messages.size,
      historyId: String(this.#historyId),
    }
  }

  async labels() {
    return this.labelList
  }

  async listMessages(options: { pageToken?: string; q?: string; maxResults?: number }) {
    this.calls.list++
    const all = [...this.messages.values()]
      .filter(
        (m) =>
          !options.q ||
          (m.labelIds?.includes('INBOX') &&
            !m.labelIds.includes('TRASH') &&
            !m.labelIds.includes('SPAM')),
      )
      .sort((a, b) => Number(b.internalDate) - Number(a.internalDate))
    const start = Number(options.pageToken ?? 0)
    const size = options.maxResults ?? 500
    const page = all.slice(start, start + size)
    return {
      messages: page.map((m) => ({ id: m.id, threadId: m.threadId })),
      ...(start + size < all.length ? { nextPageToken: String(start + size) } : {}),
      resultSizeEstimate: all.length,
    }
  }

  async getMessage(id: string) {
    this.calls.getMessage++
    const m = this.messages.get(id)
    return m ? structuredClone(m) : null
  }

  async getMessageLabels(id: string): Promise<string[] | null> {
    const state = await this.getMessageState(id)
    return state ? (state.labelIds ?? []) : null
  }

  async getMessageState(id: string): Promise<GmailMessageState | null> {
    const message = this.messages.get(id)
    const state = message
      ? { labelIds: [...(message.labelIds ?? [])], historyId: message.historyId }
      : null
    this.onRead?.(new Map(state ? [[id, state.labelIds]] : []))
    const pause = this.afterLabelRead
    this.afterLabelRead = undefined
    await pause?.()
    return state
  }

  async getThreadMessages(id: string) {
    const snapshot = [...this.messages.values()]
      .filter((message) => message.threadId === id)
      .map((message) => structuredClone(message))
    const edit = this.afterThreadRead
    this.afterThreadRead = undefined
    this.onRead?.(new Map(snapshot.map((message) => [message.id, message.labelIds ?? []])))
    edit?.()
    return snapshot
  }

  async modifyMessage(id: string, addLabelIds: string[], removeLabelIds: string[]) {
    // Capture the acknowledgement at commit, before test hooks can interleave owner edits.
    const result = await this.batchModify([id], addLabelIds, removeLabelIds)
    if (!result) throw new GmailHttpError(404, 'notFound', 'Message no longer exists')
    return result
  }

  async batchModify(ids: string[], addLabelIds: string[], removeLabelIds: string[]) {
    this.beforeWrite?.({ kind: 'batch', ids, add: addLabelIds, remove: removeLabelIds })
    const failure = this.batchFailure
    this.batchFailure = undefined
    for (const id of failure ? ids.slice(0, failure.applied) : ids) {
      const labels = this.messages.get(id)?.labelIds
      if (labels)
        this.#setLabels(
          id,
          [...new Set([...labels.filter((l) => !removeLabelIds.includes(l)), ...addLabelIds])],
          'amc',
        )
    }
    if (failure) throw failure.error
    const message = this.messages.get(ids[0] ?? '')
    return message && { labelIds: [...(message.labelIds ?? [])], historyId: message.historyId }
  }

  async setTrashed(id: string, trashed: boolean): Promise<GmailMessageState> {
    this.beforeWrite?.({ kind: 'trash', ids: [id], trashed })
    const failure = this.trashFailure
    this.trashFailure = undefined
    if (failure && !failure.afterWrite) throw failure.error
    const message = this.messages.get(id)
    if (!message) throw new GmailHttpError(404, 'notFound', 'Message no longer exists')
    const labels = message.labelIds ?? []
    const next = trashed ? [...new Set([...labels, 'TRASH'])] : labels.filter((l) => l !== 'TRASH')
    this.#setLabels(id, next, 'amc')
    if (failure) throw failure.error
    return { labelIds: next, historyId: message.historyId }
  }

  async createLabel(name: string): Promise<GmailLabel> {
    const label = { id: `Label_${this.labelList.length}`, name, type: 'user' as const }
    if (this.labelList.some((existing) => existing.name === name))
      throw new GmailHttpError(409, 'conflict', 'Label already exists')
    this.labelList.push(label)
    return label
  }

  async history(
    startHistoryId: string,
    pageToken?: string,
    writeback = false,
  ): Promise<GmailHistoryList | null> {
    if (BigInt(startHistoryId) < BigInt(this.oldestHistory)) return null
    const records = this.#history.filter(
      (record) =>
        BigInt(record.id) > BigInt(startHistoryId) &&
        (!writeback ||
          record.messagesAdded ||
          record.labelsAdded ||
          record.labelsRemoved ||
          record.messagesDeleted),
    )
    const offset = Number(pageToken ?? 0)
    const end = offset + this.historyPageSize
    return {
      history: records.slice(offset, end),
      ...(end < records.length ? { nextPageToken: String(end) } : {}),
      historyId: String(this.#historyId),
    }
  }

  async attachment() {
    return new Uint8Array([1, 2, 3])
  }

  drafts = new Map<string, { raw: string; messageId: string; threadId: string }>()
  #draftSeq = 0

  async saveDraft(input: {
    draftId?: string
    raw: string
    threadId?: string
  }): Promise<GmailDraft> {
    const draftId = input.draftId ?? `d${++this.#draftSeq}`
    const old = this.drafts.get(draftId)
    if (old) this.remove(old.messageId)
    const messageId = `draftmsg${++this.#draftSeq}`
    const subject = /^Subject: (.*)$/m.exec(input.raw)?.[1] ?? ''
    const body = Buffer.from(input.raw.split('\r\n\r\n')[1] ?? '', 'base64').toString('utf8')
    const m = this.add(messageId, {
      threadId: input.threadId ?? `t-${messageId}`,
      labels: ['DRAFT'],
      subject,
      from: this.address,
      body,
      date: Date.now(),
    })
    this.drafts.set(draftId, { raw: input.raw, messageId, threadId: m.threadId })
    return { id: draftId, message: { id: messageId, threadId: m.threadId } }
  }

  async deleteDraft(draftId: string) {
    const d = this.drafts.get(draftId)
    if (d) this.remove(d.messageId)
    this.drafts.delete(draftId)
  }
}
