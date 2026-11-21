import type {
  GmailApi,
  GmailDraft,
  GmailHistoryList,
  GmailHistoryRecord,
  GmailLabel,
  GmailMessage,
  GmailProfile,
} from './types.ts'

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
  /** History older than this id is "expired" (Gmail answers 404). */
  oldestHistory = 0
  calls = { getMessage: 0, list: 0 }
  trashFailure: { afterWrite: boolean; error: Error } | undefined
  batchFailure: { applied: number; error: Error } | undefined
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
    this.#record({
      messagesAdded: [{ message: { id, threadId: message.threadId, labelIds: message.labelIds } }],
    })
    return message
  }

  setLabels(id: string, labels: string[]) {
    const m = this.messages.get(id)
    if (!m) throw new Error(`no message ${id}`)
    m.labelIds = labels
    this.#record({
      labelsAdded: [{ message: { id, threadId: m.threadId, labelIds: labels }, labelIds: [] }],
    })
  }

  remove(id: string) {
    const m = this.messages.get(id)
    this.messages.delete(id)
    if (m) this.#record({ messagesDeleted: [{ message: { id, threadId: m.threadId } }] })
  }

  #record(record: Omit<GmailHistoryRecord, 'id'>) {
    this.#historyId++
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
      .filter((m) => !options.q || m.labelIds?.includes('INBOX'))
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
    const message = this.messages.get(id)
    const labels = message ? [...(message.labelIds ?? [])] : null
    const pause = this.afterLabelRead
    this.afterLabelRead = undefined
    await pause?.()
    return labels
  }

  async getThreadMessages(id: string) {
    return [...this.messages.values()]
      .filter((message) => message.threadId === id)
      .map((message) => structuredClone(message))
  }

  async batchModify(ids: string[], addLabelIds: string[], removeLabelIds: string[]) {
    const failure = this.batchFailure
    this.batchFailure = undefined
    for (const id of failure ? ids.slice(0, failure.applied) : ids) {
      const labels = await this.getMessageLabels(id)
      if (labels)
        this.setLabels(id, [
          ...new Set([...labels.filter((l) => !removeLabelIds.includes(l)), ...addLabelIds]),
        ])
    }
    if (failure) throw failure.error
  }

  async setTrashed(id: string, trashed: boolean): Promise<string[]> {
    const failure = this.trashFailure
    this.trashFailure = undefined
    if (failure && !failure.afterWrite) throw failure.error
    const labels = (await this.getMessageLabels(id)) ?? []
    const next = trashed
      ? [...new Set([...labels.filter((l) => l !== 'INBOX'), 'TRASH'])]
      : labels.filter((l) => l !== 'TRASH')
    this.setLabels(id, next)
    if (failure) throw failure.error
    return next
  }

  async createLabel(name: string): Promise<GmailLabel> {
    const label = { id: `Label_${this.labelList.length}`, name, type: 'user' as const }
    this.labelList.push(label)
    return label
  }

  async history(startHistoryId: string): Promise<GmailHistoryList | null> {
    if (Number(startHistoryId) < this.oldestHistory) return null
    return {
      history: this.#history.filter((h) => Number(h.id) > Number(startHistoryId)),
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
