import { randomUUID } from 'node:crypto'
import { EventEmitter } from 'node:events'
import {
  actionLabels,
  applyLabelPatch,
  type LabelPatch,
  type MessageDetail,
  type MutationRequest,
  MutationResponse,
  type MutationResult,
  type OrganiseAction,
  SNOOZED_LABEL,
  type ThreadSummary,
} from '@amc/protocol'
import { type EngineClient, EngineError } from './engine'
import type { Replica } from './replica'

type Patch = { labels: Record<string, LabelPatch>; muted?: boolean; snoozedUntil?: number | null }

interface QueueRow {
  id: string
  thread_id: string | null
  request: string
  patch: string
  inverse: string
  status: 'unsent' | MutationResult['status']
  modseq: number | null
  error: string | null
}

export const ORGANISE_SCHEMA = `
  CREATE TABLE IF NOT EXISTS organise_queue (
    seq INTEGER PRIMARY KEY, id TEXT UNIQUE NOT NULL, thread_id TEXT, request TEXT NOT NULL,
    patch TEXT NOT NULL, inverse TEXT NOT NULL, undo_of TEXT,
    status TEXT NOT NULL DEFAULT 'unsent', modseq INTEGER, error TEXT, notified INTEGER NOT NULL DEFAULT 0
  );
  CREATE INDEX IF NOT EXISTS organise_queue_thread ON organise_queue (thread_id, seq);
  CREATE INDEX IF NOT EXISTS organise_queue_sync ON organise_queue (status, modseq);
  CREATE TABLE IF NOT EXISTS organise_notice (id TEXT PRIMARY KEY, message TEXT NOT NULL);
  CREATE TEMP TABLE organise_thread (
    id TEXT PRIMARY KEY, account_id TEXT NOT NULL, last_message_at INTEGER NOT NULL,
    in_inbox INTEGER NOT NULL, unread_count INTEGER NOT NULL, starred INTEGER NOT NULL,
    label_ids TEXT NOT NULL, haystack TEXT NOT NULL, data TEXT NOT NULL
  );
  CREATE TEMP VIEW effective_thread AS
    SELECT t.* FROM thread t WHERE NOT EXISTS (SELECT 1 FROM organise_thread o WHERE o.id = t.id)
    UNION ALL SELECT * FROM organise_thread;
`

function applyPatch(thread: ThreadSummary, messages: MessageDetail[], patch: Patch) {
  const prefix = `${thread.accountId}:`
  for (const [index, message] of messages.entries()) {
    const next = patch.labels[message.id]
    if (!next) continue
    const labelIds = applyLabelPatch(message.labelIds, next)
    messages[index] = {
      ...message,
      labelIds,
      unread: labelIds.includes(`${prefix}UNREAD`),
      starred: labelIds.includes(`${prefix}STARRED`),
    }
  }
  if (patch.muted !== undefined) thread.muted = patch.muted
  if (patch.snoozedUntil !== undefined) thread.snoozedUntil = patch.snoozedUntil
  if (messages.length === thread.messageCount && messages.length) {
    thread.labelIds = [...new Set(messages.flatMap((m) => m.labelIds))].sort()
    thread.unreadCount = messages.filter((m) => m.unread).length
    thread.starred = messages.some((m) => m.starred)
  } else if (
    patch.snoozedUntil ||
    patch.muted ||
    messages.some((m) => patch.labels[m.id]?.[`${prefix}INBOX`] === false)
  ) {
    thread.labelIds = thread.labelIds.filter((id) => id !== `${prefix}INBOX`)
  }
  thread.inInbox =
    !thread.muted && thread.snoozedUntil == null && thread.labelIds.includes(`${prefix}INBOX`)
}

function patchesFor(
  action: Exclude<OrganiseAction, { kind: 'undo' }>,
  thread: ThreadSummary,
  messages: MessageDetail[],
) {
  const patch: Patch = { labels: {} }
  const inverse: Patch = { labels: {} }
  const state = actionLabels(action, thread.accountId)
  const snoozed = `${thread.accountId}:${SNOOZED_LABEL}`
  if (action.kind === 'mute') {
    patch.muted = action.value
    inverse.muted = thread.muted ?? false
  }
  if (action.kind === 'snooze') {
    patch.snoozedUntil = action.until
    inverse.snoozedUntil = thread.snoozedUntil ?? null
    state[snoozed] = true
  } else if (
    thread.snoozedUntil &&
    (action.kind === 'archive' || (action.kind === 'trash' && action.value))
  ) {
    patch.snoozedUntil = null
    inverse.snoozedUntil = thread.snoozedUntil
    state[snoozed] = false
  }
  for (const message of messages) {
    if (message.labelIds.includes(`${thread.accountId}:DRAFT`)) continue
    patch.labels[message.id] = state
    inverse.labels[message.id] = Object.fromEntries(
      Object.keys(state).map((id) => [id, message.labelIds.includes(id)]),
    )
  }
  return { patch, inverse }
}

export class LocalOrganise {
  readonly replica: Replica

  constructor(replica: Replica) {
    this.replica = replica
  }

  get #db() {
    return this.replica.db
  }

  enqueue(action: OrganiseAction): string {
    let threadId = action.threadId
    let patch: Patch = { labels: {} }
    let inverse: Patch = { labels: {} }
    let target: string | undefined
    if (action.kind === 'undo') {
      const row = this.#db
        .prepare(
          `SELECT q.* FROM organise_queue q
         WHERE q.status != 'failed' AND q.undo_of IS NULL
           AND json_extract(q.request, '$.action.kind') != 'undo'
           AND (?1 IS NULL OR q.thread_id = ?1)
           AND NOT EXISTS (SELECT 1 FROM organise_queue u WHERE u.undo_of = q.id AND u.status != 'failed')
         ORDER BY q.seq DESC LIMIT 1`,
        )
        .get(threadId ?? null) as unknown as QueueRow | undefined
      if (action.mutationId && row?.id !== action.mutationId)
        throw new Error('Undo the newer action on this Thread first')
      if (row) {
        threadId = row.thread_id ?? undefined
        patch = JSON.parse(row.inverse)
        target = row.id
      }
      action = { kind: 'undo', threadId, mutationId: target }
    } else {
      const thread = this.replica.thread(action.threadId)
      if (!thread) throw new Error('Thread is no longer available')
      if (thread.messages.length !== thread.thread.messageCount)
        throw new Error('Wait for this Thread to finish syncing')
      const projected = patchesFor(action, thread.thread, thread.messages)
      patch = projected.patch
      inverse = projected.inverse
    }
    const id = randomUUID()
    const request: MutationRequest = { id, action }
    this.replica.transaction(() => {
      this.#db
        .prepare(
          'INSERT INTO organise_queue (id, thread_id, request, patch, inverse, undo_of) VALUES (?, ?, ?, ?, ?, ?)',
        )
        .run(
          id,
          threadId ?? null,
          JSON.stringify(request),
          JSON.stringify(patch),
          JSON.stringify(inverse),
          target ?? null,
        )
      this.rebuild()
    })
    return id
  }

  messages(thread: ThreadSummary, base: MessageDetail[]): MessageDetail[] {
    const rows = this.#db
      .prepare(
        'SELECT patch FROM organise_queue WHERE thread_id = ? AND (modseq IS NULL OR modseq > ?) ORDER BY seq',
      )
      .all(thread.id, this.replica.modseq ?? -1) as { patch: string }[]
    for (const row of rows) applyPatch(thread, base, JSON.parse(row.patch) as Patch)
    return base
  }

  rebuild() {
    const current = this.replica.modseq ?? -1
    this.#db.exec('DELETE FROM organise_thread')
    const rows = this.#db
      .prepare(
        'SELECT DISTINCT thread_id FROM organise_queue WHERE thread_id IS NOT NULL AND (modseq IS NULL OR modseq > ?)',
      )
      .all(current) as { thread_id: string }[]
    for (const row of rows) {
      const base = this.replica.baseThread(row.thread_id)
      if (!base) continue
      const thread = base.thread
      this.messages(thread, base.messages)
      this.#db
        .prepare(
          `INSERT INTO organise_thread SELECT id, account_id, last_message_at, ?, ?, ?, ?, haystack, ?
         FROM thread WHERE id = ?`,
        )
        .run(
          Number(thread.inInbox),
          thread.unreadCount,
          Number(thread.starred),
          JSON.stringify(thread.labelIds),
          JSON.stringify(thread),
          thread.id,
        )
    }
  }

  unsent(): MutationRequest | null {
    const row = this.#db
      .prepare("SELECT request FROM organise_queue WHERE status = 'unsent' ORDER BY seq LIMIT 1")
      .get() as { request: string } | undefined
    return row ? (JSON.parse(row.request) as MutationRequest) : null
  }

  pending(): string[] {
    return (
      this.#db
        .prepare("SELECT id FROM organise_queue WHERE status = 'pending' ORDER BY seq LIMIT 100")
        .all() as { id: string }[]
    ).map((row) => row.id)
  }

  resolve(results: MutationResult[]): void {
    this.replica.transaction(() => {
      for (const result of results) {
        this.#db
          .prepare('UPDATE organise_queue SET status = ?, modseq = ?, error = ? WHERE id = ?')
          .run(result.status, result.modseq, result.error, result.id)
      }
      this.rebuild()
    })
  }

  errors(): { id: string; message: string }[] {
    const rows = this.#db
      .prepare(
        'SELECT id, error AS message FROM organise_queue WHERE error IS NOT NULL AND notified = 0 ORDER BY seq',
      )
      .all() as { id: string; message: string }[]
    this.#db
      .prepare('UPDATE organise_queue SET notified = 1 WHERE error IS NOT NULL AND notified = 0')
      .run()
    const internal = this.#db.prepare('SELECT id, message FROM organise_notice').all() as {
      id: string
      message: string
    }[]
    this.#db.exec('DELETE FROM organise_notice')
    return [...rows, ...internal]
  }

  notice(failures: MutationResult[]): void {
    for (const failure of failures) {
      if (failure.error)
        this.#db
          .prepare('INSERT OR IGNORE INTO organise_notice VALUES (?, ?)')
          .run(failure.id, failure.error)
    }
  }

  clear(): void {
    this.#db.exec(
      'DELETE FROM organise_queue; DELETE FROM organise_thread; DELETE FROM organise_notice;',
    )
  }
}

export class OrganiseSync extends EventEmitter<{ changed: [] }> {
  readonly #local: LocalOrganise
  readonly #engine: EngineClient
  readonly #pull: () => Promise<void>
  readonly #controller = new AbortController()
  #timer: ReturnType<typeof setInterval> | undefined
  #running = false
  #retryAt = 0
  #failures = 0

  constructor(local: LocalOrganise, engine: EngineClient, pull: () => Promise<void>) {
    super()
    this.#local = local
    this.#engine = engine
    this.#pull = pull
  }

  start() {
    this.#timer = setInterval(() => void this.flush(), 1000)
    void this.flush()
  }

  stop() {
    clearInterval(this.#timer)
    this.#controller.abort()
  }

  async flush(): Promise<void> {
    const signal = this.#controller.signal
    if (
      signal.aborted ||
      this.#running ||
      Date.now() < this.#retryAt ||
      this.#local.replica.modseq === null
    )
      return
    const pending = this.#local.pending()
    let request = this.#local.unsent()
    if (!request && !pending.length) return
    this.#running = true
    try {
      const post = async (path: string, body: unknown) =>
        MutationResponse.parse(
          await this.#engine.request(path, {
            method: 'POST',
            body,
            signal: AbortSignal.any([signal, AbortSignal.timeout(15_000)]),
          }),
        )
      // FIFO preserves your intent across a disconnect. Submit one at a time so a deleted
      // Thread cannot reject the newer actions on other Threads.
      while (request && !signal.aborted) {
        try {
          const res = await post('/v1/mutations', { mutations: [request] })
          if (signal.aborted) return
          this.#local.resolve(res.mutations)
        } catch (error) {
          if (signal.aborted) return
          if (!(error instanceof EngineError) || ![400, 403, 409].includes(error.status))
            throw error
          this.#local.resolve([
            {
              id: request.id,
              threadId: request.action.threadId ?? '',
              modseq: 0,
              status: 'failed',
              error: error.message,
            },
          ])
        }
        this.emit('changed')
        request = this.#local.unsent()
      }
      if (pending.length) {
        const res = await post('/v1/mutations/status', { ids: pending })
        if (signal.aborted) return
        this.#local.resolve(res.mutations)
        if (res.mutations.some((row) => row.status !== 'pending')) this.emit('changed')
      }
      this.#failures = 0
      this.#retryAt = 0
      await this.#pull()
    } catch {
      this.#retryAt = Date.now() + Math.min(30_000, 1000 * 2 ** this.#failures++)
    } finally {
      this.#running = false
    }
  }
}
