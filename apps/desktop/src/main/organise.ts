import { randomUUID } from 'node:crypto'
import { EventEmitter } from 'node:events'
import {
  type AccountSummary,
  actionLabels,
  applyLabelPatch,
  imapActionError,
  imapActionLabels,
  type LabelPatch,
  type MutationRequest,
  MutationResponse,
  type MutationResult,
  OrganiseAction,
  SNOOZED_LABEL,
  type ThreadMessage,
  type ThreadSummary,
} from '@amc/protocol'
import type { OrganiseNotice } from '../shared/api'
import { type EngineClient, EngineError } from './engine'
import type { Replica } from './replica'

type Patch = { labels: Record<string, LabelPatch>; muted?: boolean; snoozedUntil?: number | null }

interface QueueRow {
  id: string
  thread_id: string | null
  request: string
  patch: string
  inverse: string
  superseded: string
  messages: string | null
  status: 'unsent' | MutationResult['status']
  modseq: number | null
  error: string | null
}

const IMAP_FLAG_NOOP = `
  q.status = 'applied' AND q.messages IS NOT NULL
  AND json_extract(q.request, '$.action.kind') IN ('read', 'star')
  AND EXISTS (
    SELECT 1 FROM thread t JOIN account a ON a.id = t.account_id
    WHERE t.id = q.thread_id AND json_extract(a.data, '$.kind') = 'imap'
  )
  AND NOT EXISTS (
    SELECT 1 FROM json_each(q.messages) j
    WHERE json_array_length(j.value, '$.appliedLabels') > 0
  )
`

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

function applyPatch(thread: ThreadSummary, messages: ThreadMessage[], patch: Patch, imap: boolean) {
  const prefix = `${thread.accountId}:`
  const marker = `${prefix}${SNOOZED_LABEL}`
  for (const [index, message] of messages.entries()) {
    const next = patch.labels[message.id]
    if (!next) continue
    // Older outbox entries can still carry optimistic marker cleanup.
    const labels = { ...next }
    delete labels[marker]
    const unreadId = `${prefix}UNREAD`
    const starredId = `${prefix}STARRED`
    const labelIds = applyLabelPatch(message.labelIds, labels)
    messages[index] = {
      ...message,
      labelIds: imap ? labelIds.filter((id) => id !== unreadId && id !== starredId) : labelIds,
      unread: imap ? (labels[unreadId] ?? message.unread) : labelIds.includes(unreadId),
      starred: imap ? (labels[starredId] ?? message.starred) : labelIds.includes(starredId),
    }
  }
  if (patch.muted !== undefined) thread.muted = patch.muted
  if (patch.snoozedUntil !== undefined) thread.snoozedUntil = patch.snoozedUntil
  if (messages.length === thread.messageCount && messages.length) {
    thread.labelIds = [...new Set(messages.flatMap((m) => m.labelIds))].sort()
    thread.unreadCount = messages.filter((m) => m.unread).length
    thread.starred = messages.some((m) => m.starred)
  } else if (
    patch.muted ||
    messages.some((m) => patch.labels[m.id]?.[`${prefix}INBOX`] === false)
  ) {
    thread.labelIds = thread.labelIds.filter((id) => id !== `${prefix}INBOX`)
  }
  thread.inInbox =
    !thread.muted &&
    (messages.length === thread.messageCount
      ? messages.some(
          (m) =>
            m.labelIds.includes(`${prefix}INBOX`) &&
            !m.labelIds.includes(`${prefix}TRASH`) &&
            !m.labelIds.includes(`${prefix}SPAM`),
        )
      : thread.labelIds.includes(`${prefix}INBOX`) && !thread.labelIds.includes(`${prefix}TRASH`))
}

function patchesFor(
  action: Exclude<OrganiseAction, { kind: 'undo' }>,
  thread: ThreadSummary,
  messages: ThreadMessage[],
  imap: boolean,
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
    inverse.snoozedUntil = null
  }
  for (const message of messages) {
    if (message.labelIds.includes(`${thread.accountId}:DRAFT`)) continue
    const delta = imap ? imapActionLabels(action, thread.accountId, message.labelIds) : state
    patch.labels[message.id] = delta
    inverse.labels[message.id] = Object.fromEntries(
      Object.keys(delta)
        .filter((id) => id !== snoozed)
        .map((id) => [
          id,
          imap && id === `${thread.accountId}:UNREAD`
            ? message.unread
            : imap && id === `${thread.accountId}:STARRED`
              ? message.starred
              : message.labelIds.includes(id),
        ]),
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

  #account(id: string): AccountSummary | undefined {
    const row = this.#db.prepare('SELECT data FROM account WHERE id = ?').get(id) as
      | { data: string }
      | undefined
    return row && (JSON.parse(row.data) as AccountSummary)
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
         LEFT JOIN thread t ON t.id = q.thread_id
         WHERE q.status != 'failed' AND q.undo_of IS NULL
           AND json_extract(q.request, '$.action.kind') != 'undo'
           AND (?1 IS NULL OR q.thread_id = ?1)
           AND (?1 IS NOT NULL OR ?2 IS NOT NULL OR t.id IS NOT NULL)
           AND NOT (${IMAP_FLAG_NOOP})
           AND NOT EXISTS (SELECT 1 FROM organise_queue u WHERE u.undo_of = q.id AND u.status != 'failed')
         ORDER BY q.seq DESC LIMIT 1`,
        )
        .get(threadId ?? null, action.mutationId ?? null) as unknown as QueueRow | undefined
      if (action.mutationId && row?.id !== action.mutationId) {
        const noop = this.#db
          .prepare(`SELECT 1 FROM organise_queue q WHERE q.id = ? AND (${IMAP_FLAG_NOOP})`)
          .get(action.mutationId)
        if (noop) throw new Error('No IMAP flags changed')
        throw new Error('Undo the newer action on this Thread first')
      }
      if (row) {
        threadId = row.thread_id ?? undefined
        patch = JSON.parse(row.inverse)
        if (row.messages && (row.status === 'applied' || row.status === 'partial')) {
          const outcomes = JSON.parse(row.messages) as NonNullable<MutationResult['messages']>
          const forward = JSON.parse(row.patch) as Patch
          const defaultPatch = Object.values(forward.labels)[0] ?? {}
          patch.labels = Object.fromEntries(
            outcomes
              .filter((item) => item.appliedLabels.length)
              .map(({ messageId, appliedLabels }) => [
                messageId,
                Object.fromEntries(
                  appliedLabels
                    .filter((label) => label in (forward.labels[messageId] ?? defaultPatch))
                    .map((label) => [label, !(forward.labels[messageId] ?? defaultPatch)[label]]),
                ),
              ]),
          )
          if (row.status === 'partial') {
            delete patch.muted
          }
        } else {
          for (const id of JSON.parse(row.superseded) as string[]) delete patch.labels[id]
        }
        const thread = threadId && this.replica.baseThread(threadId)
        if (thread && this.#account(thread.thread.accountId)?.kind === 'imap') patch.labels = {}
        // The Engine checks the whole Thread before undoing Snooze.
        if (patch.snoozedUntil === null) patch.labels = {}
        target = row.id
      }
      action = { kind: 'undo', threadId, mutationId: target }
    } else {
      const thread = this.replica.thread(action.threadId)
      if (!thread) throw new Error('Thread is no longer available')
      if (thread.messages.length !== thread.thread.messageCount)
        throw new Error('Wait for this Thread to finish syncing')
      const account = this.#account(thread.thread.accountId)
      const imap = account?.kind === 'imap'
      if (imap) {
        const folders = new Set(this.replica.labels(account.id).map(({ id }) => id))
        const error = imapActionError(action, account.id, folders, account.imapMoves)
        if (error) throw new Error(error)
        if (action.kind === 'snooze' && !thread.thread.labelIds.includes(`${account.id}:INBOX`))
          throw new Error('Snooze is only available for IMAP threads in the Inbox')
      }
      const projected = patchesFor(action, thread.thread, thread.messages, imap)
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

  messages(thread: ThreadSummary, base: ThreadMessage[]): ThreadMessage[] {
    const rows = this.#db
      .prepare(
        `SELECT patch FROM organise_queue
         WHERE thread_id = ? AND (modseq IS NULL OR modseq > ?)
           AND (status != 'pending' OR error IS NULL) ORDER BY seq`,
      )
      .all(thread.id, this.replica.modseq ?? -1) as {
      patch: string
    }[]
    if (!rows.length) return base
    const imap = this.#account(thread.accountId)?.kind === 'imap'
    for (const row of rows) applyPatch(thread, base, JSON.parse(row.patch) as Patch, imap)
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
          .prepare(
            'UPDATE organise_queue SET status = ?, modseq = ?, error = ?, superseded = ?, messages = ? WHERE id = ?',
          )
          .run(
            result.status,
            result.modseq,
            result.error,
            JSON.stringify(result.superseded ?? []),
            result.messages ? JSON.stringify(result.messages) : null,
            result.id,
          )
      }
      this.rebuild()
    })
  }

  refusePending(message: string, noticeId: string = randomUUID()): void {
    this.replica.transaction(() => {
      this.#db
        .prepare(
          "UPDATE organise_queue SET status = 'failed', modseq = 0 WHERE status IN ('unsent', 'pending')",
        )
        .run()
      this.#db.prepare('INSERT INTO organise_notice VALUES (?, ?)').run(noticeId, message)
      this.rebuild()
    })
  }

  errors(): OrganiseNotice[] {
    const rows = this.#db
      .prepare(
        `UPDATE organise_queue AS q SET notified = 1 WHERE notified = 0
           AND (error IS NOT NULL OR (${IMAP_FLAG_NOOP}))
           AND (status != 'partial' OR modseq <= ?)
         RETURNING id, error AS message, status, request, messages, thread_id, undo_of`,
      )
      .all(this.replica.modseq ?? -1) as unknown as (QueueRow & {
      message: string | null
      undo_of: string | null
    })[]
    const failures = rows.map((row): OrganiseNotice => {
      if (row.message === null)
        return { id: row.id, message: 'No IMAP flags changed', quiet: true, updateOnly: true }
      if (row.status !== 'partial' || !row.messages) return { id: row.id, message: row.message }
      const outcomes = JSON.parse(row.messages) as NonNullable<MutationResult['messages']>
      const { action } = JSON.parse(row.request) as MutationRequest
      const trash = action.kind === 'trash' ? `${row.thread_id?.split(':')[0]}:TRASH` : null
      const hasLabel = (labels: string[]) =>
        trash === null ? labels.length > 0 : labels.includes(trash)
      const applied = outcomes.filter((item) =>
        trash ? hasLabel(item.appliedLabels) : item.status === 'applied',
      ).length
      const failed = outcomes.filter((item) =>
        trash ? hasLabel(item.failedLabels) : item.status === 'failed',
      ).length
      const total = trash
        ? outcomes.filter((item) =>
            [
              item.appliedLabels,
              item.failedLabels,
              item.supersededLabels,
              item.uncertainLabels ?? [],
            ].some(hasLabel),
          ).length
        : outcomes.length
      const uncertain = outcomes.some((item) => item.uncertainLabels?.length)
      const accountId = row.thread_id?.split(':')[0]
      const imap = accountId && this.#account(accountId)?.kind === 'imap'
      const verb = action.kind === 'archive' ? 'Archived' : 'Changed'
      let message = row.message
      if (trash && total) {
        const detail = failed && !uncertain && !imap ? `${failed} couldn't be changed` : row.message
        message = `${verb} ${applied} of ${total}. ${detail}`
      } else if (failed && !uncertain && !imap) {
        message = `${verb} ${applied} of ${total}. ${failed} couldn't be changed`
      }
      return {
        id: row.id,
        message,
        undo:
          row.thread_id && !row.undo_of && outcomes.some((item) => item.appliedLabels.length)
            ? { kind: 'undo', threadId: row.thread_id, mutationId: row.id }
            : undefined,
      }
    })
    const internal = this.#db.prepare('SELECT id, message FROM organise_notice').all() as {
      id: string
      message: string
    }[]
    this.#db.exec('DELETE FROM organise_notice')
    const conflicts = this.#db
      .prepare(
        `UPDATE organise_queue SET supersession_notified = 1
       WHERE supersession_notified = 0 AND status IN ('applied', 'failed')
         AND superseded != '[]' AND modseq <= ?
       RETURNING id, error`,
      )
      .all(this.replica.modseq ?? -1) as { id: string; error: string | null }[]
    return [
      ...failures,
      ...internal,
      ...conflicts.map(({ id, error }) => ({
        id: error ? `${id}:superseded` : id,
        message: 'Changed elsewhere, left as is',
        quiet: true,
      })),
    ]
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
  #refusal: string | null = null

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

  enqueue(input: unknown, snoozeEnabled = false): string {
    if (
      !snoozeEnabled &&
      input !== null &&
      typeof input === 'object' &&
      'kind' in input &&
      (input.kind === 'snooze' || input.kind === 'unsnooze')
    )
      throw new Error('Snooze is disabled on this Engine')
    const action = OrganiseAction.parse(input)
    if (this.#refusal) throw new Error(this.#refusal)
    return this.#local.enqueue(action)
  }

  async flush(): Promise<void> {
    const signal = this.#controller.signal
    if (
      signal.aborted ||
      this.#refusal ||
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
          if (!(error instanceof EngineError) || ![400, 409].includes(error.status)) throw error
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
        if (res.mutations.some((row) => row.status !== 'pending' || row.error)) this.emit('changed')
      }
      this.#failures = 0
      this.#retryAt = 0
      await this.#pull()
    } catch (error) {
      if (signal.aborted) return
      if (error instanceof EngineError && (error.status === 401 || error.status === 403)) {
        this.#refusal =
          error.status === 401
            ? 'The Engine rejected this pairing. Pair this Mac again to organise mail.'
            : `The Engine refused Organise. ${error.message}`
        this.#local.refusePending(this.#refusal, request?.id ?? pending[0])
        this.emit('changed')
        return
      }
      this.#retryAt = Date.now() + Math.min(30_000, 1000 * 2 ** this.#failures++)
    } finally {
      this.#running = false
    }
  }
}
