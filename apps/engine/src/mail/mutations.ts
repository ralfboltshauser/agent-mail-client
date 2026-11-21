import { randomUUID } from 'node:crypto'
import {
  actionLabels,
  applyLabelPatch,
  type LabelPatch,
  type MutationMessageResult,
  type MutationRequest,
  type MutationResult,
  type OrganiseAction,
  SNOOZED_LABEL,
} from '@amc/protocol'
import { transaction } from '../db/database.ts'
import type { Logger } from '../log.ts'
import { GmailHttpError } from '../providers/gmail/http.ts'
import { OAuthError } from '../providers/gmail/oauth.ts'
import type { GmailApi, GmailMessage } from '../providers/gmail/types.ts'
import { labelId, type MailStore, messageId } from './store.ts'

const INTERNAL = 'engine'
const CLEAR_SNOOZE = { snoozedUntil: null, noReply: false, startedAt: null }

interface ThreadState {
  muted: boolean
  snoozedUntil: number | null
  noReply: boolean
  startedAt: number | null
}
const EMPTY_STATE: ThreadState = {
  muted: false,
  snoozedUntil: null,
  noReply: false,
  startedAt: null,
}

interface ThreadRow {
  id: string
  account_id: string
  organise_state: string
  kind: string
}

interface MutationRow {
  id: string
  account_id: string
  thread_id: string
  principal: string
  request: string
  status: MutationResult['status']
  error: string | null
  modseq: number
  attempts: number
  prepared: number
  progress: number
  write_journal: string | null
  next_attempt: number
  state_patch: string
  state_before: string
  undo_of: string | null
}

interface PatchRow {
  message_id: string
  patch: string
  before: string
}

interface Change {
  message_id: string
  before: Record<string, boolean | null>
  after: LabelPatch
}

interface JournalEntry {
  archiveScope?: string[]
  observations?: Change[]
  applied: Change[]
  superseded: Change[]
  failed: Change[]
  uncertain?: Change[]
  error?: string
  pending?: { change: Change; historyId?: string }
}

interface ProviderObservation {
  labels: string[]
  historyId: string | undefined
}

interface Step {
  patch: LabelPatch
  trash?: boolean
  changes: Change[]
}

function readJournal(row: MutationRow): JournalEntry[] {
  return JSON.parse(row.write_journal ?? '[]') as JournalEntry[]
}

function messageResults(journal: JournalEntry[]): MutationMessageResult[] {
  const outcomes = new Map<string, MutationMessageResult>()
  for (const entry of journal) {
    for (const kind of ['applied', 'superseded', 'failed', 'uncertain'] as const) {
      for (const change of entry[kind] ?? []) {
        const outcome = outcomes.get(change.message_id) ?? {
          messageId: change.message_id,
          status: 'superseded',
          appliedLabels: [],
          supersededLabels: [],
          failedLabels: [],
        }
        const labels = outcome[`${kind}Labels`] ?? []
        for (const label of Object.keys(change.after)) {
          if (!labels.includes(label)) labels.push(label)
        }
        outcome[`${kind}Labels`] = labels
        outcome.status = outcome.uncertainLabels?.length
          ? 'uncertain'
          : outcome.failedLabels.length
            ? 'failed'
            : outcome.appliedLabels.length
              ? 'applied'
              : 'superseded'
        outcomes.set(change.message_id, outcome)
      }
    }
  }
  return [...outcomes.values()]
}

function result(row: MutationRow): MutationResult {
  const messages = messageResults(readJournal(row))
  return {
    id: row.id,
    threadId: row.thread_id,
    status: row.status,
    error: row.error,
    modseq: row.modseq,
    messages,
    superseded: messages
      .filter((message) => message.supersededLabels.length)
      .map((m) => m.messageId),
  }
}

function stepsFor(accountId: string, changes: Change[]): Step[] {
  const trash = labelId(accountId, 'TRASH')
  const endpoints: Step[] = []
  const labels: Step[] = []
  for (const change of changes) {
    const patch = { ...change.after }
    if (trash in patch) {
      const value = Boolean(patch[trash])
      const after = { [trash]: value }
      endpoints.push({ patch: after, trash: value, changes: [{ ...change, after }] })
      delete patch[trash]
    }
    if (Object.keys(patch).length) labels.push({ patch, changes: [{ ...change, after: patch }] })
  }
  return [...endpoints, ...labels]
}

function fromPatch(row: PatchRow): Change {
  return {
    message_id: row.message_id,
    before: JSON.parse(row.before),
    after: JSON.parse(row.patch),
  }
}

function combine(changes: Change[]): Change[] {
  const combined = new Map<string, Change>()
  for (const { message_id, before, after } of changes) {
    const entry = combined.get(message_id) ?? { message_id, before: {}, after: {} }
    for (const [key, present] of Object.entries(after)) {
      if (!(key in entry.before)) entry.before[key] = Boolean(before[key])
      entry.after[key] = present
    }
    combined.set(message_id, entry)
  }
  return [...combined.values()]
}

function inverse(changes: Change[]): Change[] {
  return combine(changes).map(({ message_id, before, after }) => ({
    message_id,
    before: after,
    after: Object.fromEntries(
      Object.entries(before).map(([label, value]) => [label, Boolean(value)]),
    ),
  }))
}

export class MutationError extends Error {}
export class MutationPermissionError extends MutationError {}

export class Mutations {
  readonly #store: MailStore
  readonly #api: (accountId: string) => GmailApi | null
  readonly #log: Logger
  readonly #now: () => number
  readonly #running = new Map<string, Promise<void>>()
  #timer: ReturnType<typeof setInterval> | undefined

  constructor(
    store: MailStore,
    api: (accountId: string) => GmailApi | null,
    log: Logger,
    now = Date.now,
  ) {
    this.#store = store
    this.#api = api
    this.#log = log
    this.#now = now
  }

  get #db() {
    return this.#store.db
  }

  start() {
    this.#timer ??= setInterval(() => this.kick(), 1000)
    this.kick()
  }

  async stop() {
    clearInterval(this.#timer)
    this.#timer = undefined
    await Promise.all(this.#running.values())
  }

  kick() {
    void this.tick().catch((error) => this.#log.error({ err: error }, 'organise queue error'))
  }

  submit(principal: string, requests: MutationRequest[], allowTrash = true): MutationResult[] {
    return transaction(this.#db, () =>
      requests.map((request) => this.#submit(principal, request, allowTrash)),
    )
  }

  lookup(principal: string, ids: string[]): MutationResult[] {
    return ids.flatMap((id) => {
      const row = this.#row(id)
      return row?.principal === principal ? [result(row)] : []
    })
  }

  internalFailures(since: number, through: number): MutationResult[] {
    const rows = this.#db
      .prepare(
        "SELECT * FROM mutation WHERE principal = ? AND status IN ('failed', 'partial') AND modseq > ? AND modseq <= ? ORDER BY modseq",
      )
      .all(INTERNAL, since, through) as unknown as MutationRow[]
    return rows.map(result)
  }

  #row(id: string): MutationRow | undefined {
    return this.#db.prepare('SELECT * FROM mutation WHERE id = ?').get(id) as
      | MutationRow
      | undefined
  }

  #thread(id: string | undefined): ThreadRow {
    const thread = this.#db
      .prepare(
        'SELECT t.id, t.account_id, t.organise_state, a.kind FROM thread t JOIN account a ON a.id = t.account_id WHERE t.id = ?',
      )
      .get(id ?? '') as ThreadRow | undefined
    if (!thread) throw new MutationError('Thread is no longer available')
    if (thread.kind !== 'gmail')
      throw new MutationError('Organise is currently available for Gmail Accounts')
    return thread
  }

  #committedState(threadId: string): ThreadState {
    const row = this.#db.prepare('SELECT organise_state FROM thread WHERE id = ?').get(threadId) as
      | { organise_state: string }
      | undefined
    return { ...EMPTY_STATE, ...JSON.parse(row?.organise_state ?? '{}') }
  }

  #state(thread: ThreadRow): ThreadState {
    const rows = this.#db
      .prepare(
        "SELECT state_patch FROM mutation WHERE thread_id = ? AND status = 'pending' ORDER BY seq",
      )
      .all(thread.id) as { state_patch: string }[]
    return Object.assign(
      {},
      EMPTY_STATE,
      JSON.parse(thread.organise_state),
      ...rows.map((row) => JSON.parse(row.state_patch)),
    )
  }

  #submit(principal: string, request: MutationRequest, allowTrash: boolean): MutationResult {
    const action = request.action
    if (action.kind === 'trash' && !allowTrash)
      throw new MutationPermissionError('Only the owner can move mail to or from Trash')
    const existing = this.#row(request.id)
    const body = JSON.stringify(request.action)
    if (existing) {
      if (existing.principal !== principal || existing.request !== body) {
        throw new MutationError('Mutation id is already in use')
      }
      return result(existing)
    }

    if (action.kind === 'undo') {
      const target = this.#db
        .prepare(
          `SELECT m.* FROM mutation m JOIN thread t ON t.id = m.thread_id
         WHERE m.principal = ? AND (?2 IS NULL OR m.thread_id = ?2)
           AND m.status != 'failed' AND m.undo_of IS NULL
           AND NOT EXISTS (SELECT 1 FROM mutation u WHERE u.undo_of = m.id AND u.status != 'failed')
         ORDER BY m.seq DESC LIMIT 1`,
        )
        .get(
          principal,
          action.threadId ??
            (action.mutationId ? (this.#row(action.mutationId)?.thread_id ?? '') : null),
        ) as MutationRow | undefined
      if (!target || (action.mutationId && target.id !== action.mutationId)) {
        throw new MutationError('There is no matching action to undo')
      }
      if (!allowTrash && JSON.parse(target.request).kind === 'trash')
        throw new MutationPermissionError('Only the owner can undo changes to Trash')
      if (target.status !== 'pending' && target.prepared !== 1)
        throw new MutationError('This action predates verified Gmail undo')
      const thread = this.#thread(target.thread_id)
      const state = this.#undoState(target)
      const inverses = new Map(
        this.#undoChanges(target, state).map((change) => [change.message_id, change.after]),
      )
      return this.#insert(
        request.id,
        principal,
        body,
        thread,
        state,
        (id) => inverses.get(id) ?? {},
        target.id,
      )
    }

    const thread = this.#thread(action.threadId)
    if (action.kind === 'label') {
      const allowed = this.#db
        .prepare(
          "SELECT 1 FROM label WHERE id = ? AND account_id = ? AND kind = 'user' AND name != ?",
        )
        .get(action.labelId, thread.account_id, SNOOZED_LABEL)
      if (!allowed) throw new MutationError('Choose a user Label from this Account')
    }
    if (action.kind === 'snooze' && action.until <= this.#now())
      throw new MutationError('Choose a time in the future')
    const { patch, statePatch } = this.#actionPatch(action, thread.account_id, this.#state(thread))
    return this.#insert(request.id, principal, body, thread, statePatch, () => patch)
  }

  #actionPatch(
    action: Exclude<OrganiseAction, { kind: 'undo' }>,
    account: string,
    state: ThreadState,
    startedAt = this.#now(),
  ) {
    const patch = actionLabels(action, account)
    const statePatch: Partial<ThreadState> = {}
    const snoozed = labelId(account, SNOOZED_LABEL)
    if (action.kind === 'snooze') {
      Object.assign(statePatch, {
        snoozedUntil: action.until,
        noReply: action.noReply ?? false,
        startedAt,
      })
      patch[snoozed] = true
    }
    if (action.kind === 'mute') statePatch.muted = action.value
    if (
      state.snoozedUntil !== null &&
      (action.kind === 'archive' || (action.kind === 'trash' && action.value))
    ) {
      Object.assign(statePatch, CLEAR_SNOOZE)
      patch[snoozed] = false
    }
    return { patch, statePatch }
  }

  #insert(
    id: string,
    principal: string,
    body: string,
    thread: ThreadRow,
    statePatch: Partial<ThreadState>,
    patchFor: (messageId: string) => LabelPatch,
    undoOf: string | null = null,
  ): MutationResult {
    const state = this.#state(thread)
    const stateBefore = Object.fromEntries(
      Object.keys(statePatch).map((key) => [key, state[key as keyof ThreadState]]),
    )
    this.#db
      .prepare(
        'INSERT INTO mutation (id, principal, account_id, thread_id, request, state_patch, state_before, undo_of) VALUES (?, ?, ?, ?, ?, ?, ?, ?)',
      )
      .run(
        id,
        principal,
        thread.account_id,
        thread.id,
        body,
        JSON.stringify(statePatch),
        JSON.stringify(stateBefore),
        undoOf,
      )
    const rows = this.#db
      .prepare('SELECT id, label_ids FROM message WHERE thread_id = ? ORDER BY id')
      .all(thread.id) as { id: string; label_ids: string }[]
    for (const row of rows) {
      const labels = JSON.parse(row.label_ids) as string[]
      if (labels.includes(labelId(thread.account_id, 'DRAFT'))) continue
      const patch = patchFor(row.id)
      const before = this.#before(thread.account_id, patch, labels)
      if (Object.keys(patch).length === 0) continue
      // Preserve the pre-M3 label baseline even if the message has never been refreshed from Gmail.
      this.#db
        .prepare(
          'UPDATE message SET provider_label_ids = label_ids WHERE id = ? AND provider_label_ids IS NULL',
        )
        .run(row.id)
      this.#db
        .prepare('INSERT INTO mutation_message VALUES (?, ?, ?, ?)')
        .run(id, row.id, JSON.stringify(patch), JSON.stringify(before))
      this.#store.refreshMessageLabels(row.id)
    }
    this.#refreshThread(thread.id, id)
    return result(this.#row(id) as MutationRow)
  }

  #patches(id: string): PatchRow[] {
    return this.#db
      .prepare('SELECT * FROM mutation_message WHERE mutation_id = ? ORDER BY message_id')
      .all(id) as unknown as PatchRow[]
  }

  #before(accountId: string, patch: LabelPatch, labels: string[]): LabelPatch {
    const keys = new Set(Object.keys(patch))
    // Trash changes the visibility of a message that carries Inbox.
    if (keys.has(labelId(accountId, 'TRASH'))) keys.add(labelId(accountId, 'INBOX'))
    return Object.fromEntries([...keys].map((label) => [label, labels.includes(label)]))
  }

  #refreshThread(threadId: string, mutationId: string) {
    const thread = this.#db
      .prepare('SELECT id, account_id, organise_state FROM thread WHERE id = ?')
      .get(threadId) as ThreadRow | undefined
    if (thread) {
      const state = this.#state(thread)
      this.#db
        .prepare(
          'UPDATE thread SET muted = ?, snoozed_until = ?, snooze_no_reply = ?, snooze_started_at = ? WHERE id = ?',
        )
        .run(
          Number(state.muted),
          state.snoozedUntil,
          Number(state.noReply),
          state.startedAt,
          threadId,
        )
      this.#store.refreshThread(threadId)
    }
    const row = this.#db
      .prepare('SELECT COALESCE(MAX(modseq), 0) AS modseq FROM change_log')
      .get() as { modseq: number }
    this.#db.prepare('UPDATE mutation SET modseq = ? WHERE id = ?').run(row.modseq, mutationId)
  }

  #undoState(original: MutationRow): Partial<ThreadState> {
    if (original.status === 'partial') return {}
    const state = JSON.parse(original.state_before) as Partial<ThreadState>
    if (state.snoozedUntil && state.snoozedUntil <= this.#now()) {
      Object.assign(state, CLEAR_SNOOZE)
    }
    return state
  }

  #undoChanges(original: MutationRow, state: Partial<ThreadState>): Change[] {
    const snoozed = labelId(original.account_id, SNOOZED_LABEL)
    const applied =
      original.status === 'pending'
        ? this.#patches(original.id).map(fromPatch)
        : readJournal(original).flatMap((entry) => entry.applied)
    return inverse(applied).map((change) => {
      if (change.after[snoozed] && !state.snoozedUntil) delete change.after[snoozed]
      return change
    })
  }

  #snoozeSweep(
    account: string,
    muted: boolean,
    snoozed: boolean,
    exiting: boolean,
    replied: boolean,
  ) {
    const inbox = labelId(account, 'INBOX')
    const snoozedLabel = labelId(account, SNOOZED_LABEL)
    const trash = labelId(account, 'TRASH')
    const spam = labelId(account, 'SPAM')
    let wake = exiting && !muted && !replied
    return (labels: string[]): LabelPatch => {
      const patch: LabelPatch = {}
      if (exiting && labels.includes(snoozedLabel)) patch[snoozedLabel] = false
      if (labels.includes(trash) || labels.includes(spam)) return patch
      if (wake) {
        patch[inbox] = true
        wake = false
      } else if ((muted || (snoozed && !exiting)) && labels.includes(inbox)) {
        patch[inbox] = false
        if (snoozed && !exiting) patch[snoozedLabel] = true
      }
      return patch
    }
  }

  async #gmailThread(api: GmailApi, row: MutationRow): Promise<GmailMessage[]> {
    return api.getThreadMessages(row.thread_id.slice(row.account_id.length + 1))
  }

  async #prepare(api: GmailApi, row: MutationRow, original: MutationRow | undefined) {
    const account = row.account_id
    const inbox = labelId(account, 'INBOX')
    // Resolve the reserved label before converting Gmail IDs into AMC labels.
    if (row.principal === INTERNAL || original || 'snoozedUntil' in JSON.parse(row.state_patch))
      await this.#snoozedLabel(api, account, false)
    const messages = await this.#gmailThread(api, row)
    transaction(this.#db, () => {
      const state = this.#committedState(row.thread_id)
      let statePatch: Partial<ThreadState>
      let muteSweep = false
      let patchFor: (id: string, labels: string[]) => LabelPatch
      const undo = new Map<string, Change>()
      if (original) {
        statePatch = this.#undoState(original)
        for (const change of this.#undoChanges(original, statePatch))
          undo.set(change.message_id, change)
        patchFor = (id) => undo.get(id)?.after ?? {}
      } else if (row.principal === INTERNAL) {
        const { replied } = JSON.parse(row.request) as { replied?: boolean }
        const isReply = Boolean(state.noReply && replied)
        const exiting =
          state.snoozedUntil !== null && (state.snoozedUntil <= this.#now() || isReply)
        statePatch = exiting ? CLEAR_SNOOZE : {}
        muteSweep = state.muted && !exiting
        const sweep = this.#snoozeSweep(
          account,
          state.muted,
          state.snoozedUntil !== null,
          exiting,
          isReply,
        )
        messages.sort(
          (a, b) =>
            Number(b.internalDate ?? 0) - Number(a.internalDate ?? 0) || b.id.localeCompare(a.id),
        )
        patchFor = (_id, labels) => sweep(labels)
      } else {
        const action = JSON.parse(row.request) as Exclude<OrganiseAction, { kind: 'undo' }>
        const { startedAt } = JSON.parse(row.state_patch) as Partial<ThreadState>
        const planned = this.#actionPatch(action, account, state, startedAt ?? undefined)
        statePatch = planned.statePatch
        patchFor = () => planned.patch
      }
      const stateBefore = Object.fromEntries(
        Object.keys(statePatch).map((key) => [key, state[key as keyof ThreadState]]),
      )
      const retainBaseline =
        (row.principal === INTERNAL && statePatch.snoozedUntil === null) ||
        (!original && JSON.parse(row.request).kind === 'archive')
      const projected = this.#patches(row.id)
      this.#db.prepare('DELETE FROM mutation_message WHERE mutation_id = ?').run(row.id)
      const insert = this.#db.prepare('INSERT INTO mutation_message VALUES (?, ?, ?, ?)')
      const muteCursor = muteSweep ? this.#historyCursor(account) : null
      this.#bumpEpoch(account)
      const found = new Set<string>()
      for (const message of messages) {
        const raw = message.labelIds ?? []
        if (raw.includes('DRAFT')) continue
        const id = messageId(account, message.id)
        found.add(id)
        const observed = this.#store.putProviderLabels(account, message.id, raw, message.historyId)
        const { labels } = observed
        const requested = patchFor(id, labels)
        if (
          muteSweep &&
          requested[inbox] === false &&
          !this.#canSuppressMute(id, observed.historyId, muteCursor)
        )
          continue
        const patch = Object.fromEntries(
          Object.entries(requested).filter(
            ([key, present]) =>
              key in (undo.get(id)?.after ?? {}) || present !== labels.includes(key),
          ),
        )
        if (Object.keys(patch).length || retainBaseline) {
          const baseline = retainBaseline
            ? { [inbox]: false, [labelId(account, SNOOZED_LABEL)]: false, ...patch }
            : patch
          const expected = undo.get(id)?.before ?? {}
          const before = {
            ...this.#before(account, baseline, labels),
            ...Object.fromEntries(
              Object.entries(expected).map(([label, value]) => [
                label,
                labels.includes(label) === value ? value : null,
              ]),
            ),
          }
          insert.run(row.id, id, JSON.stringify(patch), JSON.stringify(before))
        }
      }
      for (const [id, change] of undo) {
        if (found.has(id) || !Object.keys(change.after).length) continue
        // A Trash message may be omitted from the thread response. Verify it individually.
        insert.run(row.id, id, JSON.stringify(change.after), JSON.stringify(change.before))
      }
      for (const patch of projected) this.#store.refreshMessageLabels(patch.message_id)
      row.prepared = 1
      row.write_journal = '[]'
      row.state_patch = JSON.stringify(statePatch)
      row.state_before = JSON.stringify(stateBefore)
      this.#db
        .prepare(
          "UPDATE mutation SET prepared = 1, write_journal = '[]', state_patch = ?, state_before = ? WHERE id = ?",
        )
        .run(row.state_patch, row.state_before, row.id)
      this.#refreshThread(row.thread_id, row.id)
    })
  }

  #schedule() {
    const now = this.#now()
    const candidates = this.#db
      .prepare(
        `SELECT * FROM (
       SELECT t.id, t.account_id, t.organise_state, t.snoozed_until, t.muted, t.label_ids,
         json_extract(a.cursor, '$.historyId') AS history_cursor,
         (t.snooze_no_reply = 1 AND EXISTS (
           SELECT 1 FROM message m WHERE m.thread_id = t.id AND m.first_seen_at >= t.snooze_started_at
             AND m.sent_at >= t.snooze_started_at AND
             lower(COALESCE(json_extract(m.from_json, '$.address'), a.address)) != lower(a.address)
         )) AS replied
       FROM thread t JOIN account a ON a.id = t.account_id
       WHERE (t.snoozed_until IS NOT NULL OR t.muted = 1) AND a.status != 'auth_expired'
       AND NOT EXISTS (
         SELECT 1 FROM mutation p WHERE p.thread_id = t.id AND p.principal = ?
           AND (p.status = 'pending' OR (p.status IN ('failed', 'partial') AND p.next_attempt > ?))
       ))
       WHERE snoozed_until <= ? OR replied
          OR account_id || ':INBOX' IN (SELECT value FROM json_each(label_ids))`,
      )
      .all(INTERNAL, now, now) as unknown as (ThreadRow & {
      snoozed_until: number | null
      muted: number
      replied: number
      history_cursor: string | null
    })[]
    for (const thread of candidates) {
      const isReply = Boolean(thread.replied)
      const snoozed = thread.snoozed_until !== null
      const exiting = thread.snoozed_until !== null && (thread.snoozed_until <= now || isReply)
      const sweep = this.#snoozeSweep(
        thread.account_id,
        Boolean(thread.muted),
        snoozed,
        exiting,
        isReply,
      )
      const rows = this.#db
        .prepare(
          'SELECT id, label_ids, provider_history_id, mute_suppression_handled FROM message WHERE thread_id = ? ORDER BY sent_at DESC, id DESC',
        )
        .all(thread.id) as {
        id: string
        label_ids: string
        provider_history_id: string | null
        mute_suppression_handled: number
      }[]
      const patches = new Map<string, LabelPatch>()
      for (const row of rows) {
        const labels = JSON.parse(row.label_ids) as string[]
        if (labels.includes(labelId(thread.account_id, 'DRAFT'))) continue
        const patch = sweep(labels)
        if (
          thread.muted &&
          !exiting &&
          (row.mute_suppression_handled ||
            !this.#historyIncludes(thread.history_cursor, row.provider_history_id ?? undefined))
        )
          continue
        if (Object.keys(patch).length) patches.set(row.id, patch)
      }
      if (exiting || patches.size) {
        this.#insert(
          randomUUID(),
          INTERNAL,
          JSON.stringify({ replied: isReply }),
          thread,
          exiting ? CLEAR_SNOOZE : {},
          (id) => patches.get(id) ?? {},
        )
      }
    }
  }

  async tick(): Promise<void> {
    transaction(this.#db, () => this.#schedule())
    const now = this.#now()
    const rows = this.#db
      .prepare(
        `SELECT m.* FROM mutation m JOIN (
        SELECT MIN(seq) AS seq FROM mutation WHERE status = 'pending' GROUP BY account_id
       ) head ON head.seq = m.seq WHERE m.next_attempt <= ?`,
      )
      .all(now) as unknown as MutationRow[]
    const started: Promise<void>[] = []
    for (const row of rows) {
      if (this.#running.has(row.account_id)) continue
      // Older Engine builds allowed scoped Agent tokens to enqueue Organise.
      const nonOwner = this.#db
        .prepare("SELECT 1 FROM token WHERE id = ? AND kind NOT IN ('desktop', 'cli')")
        .get(row.principal)
      if (nonOwner) {
        const message = 'Organise requires a paired owner Client'
        this.#finish(row, 'failed', message)
        continue
      }
      const api = this.#api(row.account_id)
      if (!api) {
        const expired = this.#db
          .prepare("SELECT 1 FROM account WHERE id = ? AND status = 'auth_expired'")
          .get(row.account_id)
        if (expired) {
          const message = 'Sign in to Gmail again to organise this Account'
          const journal = readJournal(row)
          if (row.prepared) this.#failRemaining(row, journal, this.#writePlan(row).steps)
          this.#finishWrite(row, journal, message)
        }
        continue
      }
      const task = this.#write(api, row).finally(() => this.#running.delete(row.account_id))
      this.#running.set(row.account_id, task)
      started.push(task)
    }
    await Promise.all(started)
  }

  async #snoozedLabel(api: GmailApi, account: string, creating: boolean): Promise<string | null> {
    const stored = this.#db
      .prepare('SELECT provider_id FROM label WHERE account_id = ? AND name = ?')
      .get(account, SNOOZED_LABEL) as { provider_id: string } | undefined
    if (stored) return stored.provider_id
    const existing = (await api.labels()).find((label) => label.name === SNOOZED_LABEL)
    const label = existing ?? (creating ? await api.createLabel(SNOOZED_LABEL) : null)
    if (!label) return null
    this.#store.putLabel(account, {
      providerId: label.id,
      name: label.name,
      kind: label.type,
      color: null,
    })
    return label.id
  }

  #saveJournal(row: MutationRow, journal: JournalEntry[]) {
    row.write_journal = JSON.stringify(journal)
    this.#db
      .prepare('UPDATE mutation SET write_journal = ? WHERE id = ?')
      .run(row.write_journal, row.id)
  }

  #bumpEpoch(accountId: string) {
    this.#db.prepare('UPDATE account SET write_epoch = write_epoch + 1 WHERE id = ?').run(accountId)
  }

  #historyCursor(account: string): string | null {
    const row = this.#db
      .prepare("SELECT json_extract(cursor, '$.historyId') AS id FROM account WHERE id = ?")
      .get(account) as { id: string | null } | undefined
    return row?.id ?? null
  }

  #historyIncludes(cursor: string | null, revision: string | undefined): boolean {
    return Boolean(cursor && revision && BigInt(revision) <= BigInt(cursor))
  }

  #canSuppressMute(id: string, revision: string | undefined, cursor: string | null): boolean {
    // Wait for history to classify Inbox additions before suppressing a newly arrived message.
    return (
      this.#historyIncludes(cursor, revision) &&
      Boolean(
        this.#db
          .prepare('SELECT 1 FROM message WHERE id = ? AND mute_suppression_handled = 0')
          .get(id),
      )
    )
  }

  async #observe(api: GmailApi, row: MutationRow, ids: string[], thread?: GmailMessage[]) {
    const account = row.account_id
    if (!ids.length && !thread?.length) return new Map<string, ProviderObservation>()
    const messages = new Map(
      (thread ?? (await this.#gmailThread(api, row))).map((message) => [
        messageId(account, message.id),
        message,
      ]),
    )
    const observed = new Map(thread ? messages : [])
    for (const id of ids) {
      const rawId = id.slice(account.length + 1)
      const message = messages.get(id)
      if (message) observed.set(id, message)
      else {
        const state = await api.getMessageState(rawId, true)
        if (state) observed.set(id, { id: rawId, threadId: row.thread_id, ...state })
      }
    }
    return transaction(this.#db, () => {
      this.#bumpEpoch(account)
      return new Map(
        Array.from(observed, ([id, { id: rawId, labelIds = [], historyId }]) => [
          id,
          this.#store.putProviderLabels(account, rawId, labelIds, historyId),
        ]),
      )
    })
  }

  async #step(
    api: GmailApi,
    row: MutationRow,
    step: Step,
    entry: JournalEntry,
    journal: JournalEntry[],
    replan?: (messages: GmailMessage[], current: Map<string, ProviderObservation>) => Change[],
  ) {
    const account = row.account_id
    const inbox = labelId(account, 'INBOX')
    const trash = labelId(account, 'TRASH')
    const spam = labelId(account, 'SPAM')
    const snoozed = labelId(account, SNOOZED_LABEL)
    const rawId = (id: string) => id.slice(account.length + 1)
    const muteSweep =
      row.principal === INTERNAL && !replan && this.#committedState(row.thread_id).muted
    const explicitMute = row.principal !== INTERNAL && JSON.parse(row.request).kind === 'mute'
    const handlesMute = (change: Change) =>
      (muteSweep || explicitMute) && change.after[inbox] === false
    const save = () => this.#saveJournal(row, journal)
    const snoozedId =
      snoozed in step.patch
        ? await this.#snoozedLabel(api, account, Boolean(step.patch[snoozed]))
        : null

    while (true) {
      const thread = replan ? await this.#gmailThread(api, row) : undefined
      const ids = thread
        ? entry.pending
          ? [entry.pending.change.message_id]
          : []
        : step.changes.map((change) => change.message_id)
      const current = await this.#observe(api, row, ids, thread)
      const changes = replan && thread ? replan(thread, current) : step.changes
      const muteCursor = muteSweep ? this.#historyCursor(account) : null
      const pending = entry.pending
      if (pending) {
        const observed = current.get(pending.change.message_id)
        // A lost acknowledgement could hide a commit followed by an owner's edit.
        // Replay only when the provider revision still matches the dispatch read.
        if (!pending.historyId || observed?.historyId !== pending.historyId) {
          if (handlesMute(pending.change))
            this.#store.markMuteSuppressionHandled(pending.change.message_id)
          if (step.trash !== undefined) entry.uncertain = [pending.change]
          else entry.superseded = combine([...entry.superseded, pending.change])
          delete entry.pending
          save()
        }
      }

      const resolved = new Map(
        combine([
          ...entry.applied,
          ...entry.failed,
          ...entry.superseded,
          ...(entry.uncertain ?? []),
        ]).map((change) => [change.message_id, change.after]),
      )
      let candidate: Change | undefined
      for (const change of changes) {
        const { message_id, before } = change
        const labels = current.get(message_id)?.labels
        const done = resolved.get(message_id) ?? {}
        const after: LabelPatch = {}
        const superseded: LabelPatch = {}
        const muteConflict =
          muteSweep &&
          !this.#canSuppressMute(message_id, current.get(message_id)?.historyId, muteCursor)
        for (const [key, value] of Object.entries(change.after)) {
          if (key in done || (key === snoozed && !snoozedId)) continue
          if (
            muteConflict ||
            !labels ||
            labels.includes(key) !== before[key] ||
            (key === inbox && value && (labels.includes(trash) || labels.includes(spam))) ||
            (key === trash && labels.includes(inbox) !== before[inbox])
          ) {
            superseded[key] = value
          } else if (value !== before[key]) {
            after[key] = value
          }
        }
        if (Object.keys(superseded).length)
          entry.superseded = combine([...entry.superseded, { ...change, after: superseded }])
        if (Object.keys(after).length) {
          candidate = { ...change, after }
          break
        }
      }
      if (!candidate) {
        delete entry.pending
        save()
        return true
      }

      const { message_id, after } = candidate
      const historyId = current.get(message_id)?.historyId
      entry.pending = { change: candidate, historyId }
      save()
      const acknowledge = () => {
        if (handlesMute(candidate)) this.#store.markMuteSuppressionHandled(message_id)
        entry.applied = combine([...entry.applied, candidate])
        delete entry.pending
        save()
      }
      try {
        if (step.trash !== undefined) {
          const message = await api.setTrashed(rawId(message_id), step.trash)
          transaction(this.#db, () => {
            this.#bumpEpoch(account)
            this.#store.putProviderLabels(
              account,
              rawId(message_id),
              message.labelIds ?? [],
              message.historyId,
            )
            acknowledge()
          })
        } else {
          const add: string[] = []
          const remove: string[] = []
          for (const [key, present] of Object.entries(after)) {
            const label = key === snoozed ? snoozedId : rawId(key)
            if (label) (present ? add : remove).push(label)
          }
          await api.batchModify([rawId(message_id)], add, remove)
          transaction(this.#db, () => {
            this.#bumpEpoch(account)
            const provider = this.#db
              .prepare(
                'SELECT provider_label_ids FROM message WHERE id = ? AND provider_history_id IS ?',
              )
              .get(message_id, historyId ?? null) as
              | { provider_label_ids: string | null }
              | undefined
            if (provider) {
              const labels = JSON.parse(provider.provider_label_ids ?? '[]') as string[]
              this.#db
                .prepare('UPDATE message SET provider_label_ids = ? WHERE id = ?')
                .run(JSON.stringify(applyLabelPatch(labels, after)), message_id)
              this.#store.refreshMessageLabels(message_id)
            }
            acknowledge()
          })
        }
      } catch (error) {
        const ambiguous =
          !(error instanceof GmailHttpError || error instanceof OAuthError) ||
          (error instanceof GmailHttpError && (error.status === 408 || error.status >= 500))
        if (!ambiguous) {
          // Gmail rejected the request before executing it.
          delete entry.pending
          save()
        }
        if (this.#retry(row, error)) return false
        entry.error ??= this.#writeError(error)
        // Re-read an unacknowledged Trash before publishing a terminal result.
        if (step.trash !== undefined && ambiguous) {
          save()
          return true
        }
        if (ambiguous && handlesMute(candidate)) this.#store.markMuteSuppressionHandled(message_id)
        entry.failed = combine([...entry.failed, candidate])
        delete entry.pending
        save()
        if (!replan) return true
        continue
      }
      if (!replan) return true
    }
  }

  #replan(
    row: MutationRow,
    messages: GmailMessage[],
    current: Map<string, ProviderObservation>,
    baseline: Map<string, Change>,
    entry: JournalEntry,
  ): Change[] {
    const account = row.account_id
    const inbox = labelId(account, 'INBOX')
    const marker = labelId(account, SNOOZED_LABEL)
    const archive = row.principal !== INTERNAL
    const applied = new Map(entry.applied.map((change) => [change.message_id, change]))
    const live = new Map<string, string[]>()
    for (const message of messages) {
      const id = messageId(account, message.id)
      const labels = current.get(id)?.labels
      if (labels && !labels.includes(labelId(account, 'DRAFT'))) live.set(id, labels)
    }
    for (const change of entry.observations ?? []) baseline.set(change.message_id, change)
    const clearingSnooze = JSON.parse(row.state_patch).snoozedUntil === null
    const changes: Change[] = []
    let wake: string | undefined
    if (!archive) {
      const { replied } = JSON.parse(row.request) as { replied?: boolean }
      const state = this.#committedState(row.thread_id)
      const eligible = (labels: string[]) =>
        !labels.includes(labelId(account, 'TRASH')) && !labels.includes(labelId(account, 'SPAM'))
      // A confirmed wake is complete. An ambiguous response also needs no replay
      // while the target is already in Inbox. A vanished target can be replaced.
      const alreadyWoke =
        entry.applied.some(({ after }) => after[inbox]) ||
        [
          ...entry.failed,
          ...entry.superseded,
          ...(entry.pending ? [entry.pending.change] : []),
        ].some(({ message_id, after }) => {
          const labels = live.get(message_id)
          return (
            after[inbox] &&
            labels &&
            eligible(labels) &&
            (labels.includes(inbox) ||
              entry.failed.some(
                (change) => change.message_id === message_id && change.after[inbox],
              ))
          )
        })
      const markerRemoved = [...live].some(
        ([id, labels]) =>
          eligible(labels) &&
          !labels.includes(marker) &&
          baseline.get(id)?.before[marker] &&
          applied.get(id)?.after[marker] !== false &&
          !(
            entry.pending?.change.message_id === id && entry.pending.change.after[marker] === false
          ),
      )
      if (
        !markerRemoved &&
        !state.muted &&
        !(state.noReply && replied) &&
        !alreadyWoke &&
        [...live.values()].some((labels) => labels.includes(marker))
      ) {
        wake = [...messages]
          .sort(
            (a, b) =>
              Number(b.internalDate ?? 0) - Number(a.internalDate ?? 0) || b.id.localeCompare(a.id),
          )
          .map((message) => messageId(account, message.id))
          .find((id) => {
            const labels = live.get(id)
            return labels && eligible(labels)
          })
      }
    }
    const scope = entry.archiveScope && new Set(entry.archiveScope)
    for (const [id, labels] of live) {
      if (scope && !scope.has(id)) continue
      const original = baseline.get(id)
      const after: LabelPatch = {}
      if (archive) {
        after[inbox] = false
        if (clearingSnooze) after[marker] = false
      } else {
        if (labels.includes(marker) || original?.before[marker]) after[marker] = false
        if (id === wake) after[inbox] = true
      }
      for (const key of Object.keys(applied.get(id)?.after ?? {})) {
        // A prior acknowledged write is complete, even if the owner edited it again.
        delete after[key]
      }
      const before = {
        ...this.#before(account, { [inbox]: false, [marker]: false }, labels),
        ...original?.before,
      }
      const change = { message_id: id, before, after }
      if (!original) {
        baseline.set(id, change)
        entry.observations ??= []
        entry.observations.push(change)
      }
      changes.push(change)
    }
    for (const [id, change] of baseline) {
      if (!live.has(id)) {
        const after = { ...change.after }
        for (const key of Object.keys(applied.get(id)?.after ?? {})) delete after[key]
        if (Object.keys(after).length)
          entry.superseded = combine([...entry.superseded, { ...change, after }])
      }
    }
    if (archive && !entry.archiveScope) entry.archiveScope = [...live.keys()]
    // Dispatch the wake before removing markers from the other messages.
    if (wake) changes.sort((a, b) => Number(b.message_id === wake) - Number(a.message_id === wake))
    return changes
  }

  #writePlan(row: MutationRow) {
    const changes = this.#patches(row.id).map(fromPatch)
    const dynamic =
      row.principal === INTERNAL
        ? JSON.parse(row.state_patch).snoozedUntil === null
        : JSON.parse(row.request).kind === 'archive'
    const steps: Step[] = dynamic
      ? [{ patch: { [labelId(row.account_id, SNOOZED_LABEL)]: false }, changes }]
      : stepsFor(row.account_id, changes)
    return { changes, dynamic, steps }
  }

  async #write(api: GmailApi, row: MutationRow) {
    const original = row.undo_of ? this.#row(row.undo_of) : undefined
    if (
      original &&
      (!['applied', 'partial'].includes(original.status) || original.prepared !== 1)
    ) {
      this.#finish(row, 'failed', 'The original action has no verified Gmail undo')
      return
    }
    if (!row.prepared) {
      try {
        await this.#prepare(api, row, original)
      } catch (error) {
        if (!this.#retry(row, error))
          this.#finish(row, 'failed', 'Could not verify current Gmail labels')
        return
      }
    }
    const journal = readJournal(row)
    const { changes, dynamic, steps } = this.#writePlan(row)
    const baseline = new Map(changes.map((change) => [change.message_id, change]))
    try {
      for (let progress = row.progress; progress < steps.length; progress++) {
        const step = steps[progress]
        if (!step) break
        const entry = journal[progress] ?? { applied: [], superseded: [], failed: [] }
        journal[progress] = entry
        const complete = await this.#step(
          api,
          row,
          step,
          entry,
          journal,
          dynamic
            ? (messages, current) => this.#replan(row, messages, current, baseline, entry)
            : undefined,
        )
        if (!complete) return
        this.#db
          .prepare('UPDATE mutation SET progress = ?, attempts = 0 WHERE id = ?')
          .run(progress + 1, row.id)
        row.attempts = 0
        row.progress = progress + 1
      }
    } catch (error) {
      if (this.#retry(row, error)) return
      this.#failRemaining(row, journal, steps)
      row.attempts = 0
      this.#db
        .prepare('UPDATE mutation SET progress = ?, attempts = 0 WHERE id = ?')
        .run(steps.length, row.id)
      row.progress = steps.length
      const entry = journal.find((entry) => entry.error)
      if (!entry) {
        const failure = journal[steps.length] ?? { applied: [], superseded: [], failed: [] }
        journal[steps.length] = failure
        failure.error = this.#writeError(error)
      }
      this.#saveJournal(row, journal)
    }

    const failure = journal.find((entry) => entry.error)?.error
    const inFlight = journal.flatMap((entry) =>
      entry.pending ? [entry.pending.change.message_id] : [],
    )
    const ids = [
      ...new Set([...messageResults(journal).map((message) => message.messageId), ...inFlight]),
    ]
    if (ids.length) {
      try {
        const current = await this.#observe(api, row, ids)
        for (const entry of journal) {
          const pending = entry.pending
          if (!pending || !(labelId(row.account_id, 'TRASH') in pending.change.after)) continue
          if (
            pending.historyId &&
            current.get(pending.change.message_id)?.historyId === pending.historyId
          )
            entry.failed = combine([...entry.failed, pending.change])
          else entry.uncertain = [pending.change]
          delete entry.pending
        }
      } catch (error) {
        if (this.#retry(row, error)) return
        this.#finishWrite(row, journal, failure ?? 'Could not verify the result with Gmail')
        return
      }
    }
    this.#finishWrite(row, journal, failure ?? null)
  }

  #failRemaining(row: MutationRow, journal: JournalEntry[], steps: Step[]) {
    for (const [index, step] of steps.entries()) {
      if (index < row.progress) continue
      const entry = journal[index] ?? { applied: [], superseded: [], failed: [] }
      journal[index] = entry
      const accountedFor = new Map(
        combine([
          ...entry.applied,
          ...entry.superseded,
          ...entry.failed,
          ...(entry.uncertain ?? []),
          ...(entry.pending ? [entry.pending.change] : []),
        ]).map(({ message_id, after }) => [message_id, after]),
      )
      for (const change of step.changes) {
        const done = accountedFor.get(change.message_id) ?? {}
        const after = Object.fromEntries(
          Object.entries(change.after).filter(([key]) => !(key in done)),
        )
        if (Object.keys(after).length) entry.failed.push({ ...change, after })
      }
    }
  }

  #finishWrite(row: MutationRow, journal: JournalEntry[], error: string | null) {
    const trash = labelId(row.account_id, 'TRASH')
    for (const entry of journal) {
      if (entry.pending && trash in entry.pending.change.after) {
        entry.uncertain = [entry.pending.change]
        delete entry.pending
      }
    }
    if (journal.some((entry) => entry.uncertain?.length)) {
      const uncertainty = 'A change to Trash may have been applied'
      error = error ? `${uncertainty}. ${error}` : uncertainty
    }
    const applied = journal.some((entry) => entry.applied.length)
    this.#finish(row, error ? (applied ? 'partial' : 'failed') : 'applied', error, journal)
  }

  #writeError(error: unknown): string {
    if (error instanceof GmailHttpError) return `Gmail refused the change (HTTP ${error.status})`
    if (error instanceof OAuthError && error.needsReauth)
      return 'Sign in to Gmail again to organise this Account'
    return 'Could not write the change to Gmail'
  }

  #retry(row: MutationRow, error: unknown): boolean {
    const transient =
      !(error instanceof GmailHttpError || error instanceof OAuthError) ||
      (error instanceof OAuthError && !error.needsReauth) ||
      (error instanceof GmailHttpError &&
        (error.status === 401 ||
          error.status === 404 ||
          error.status === 408 ||
          error.status === 429 ||
          error.status >= 500 ||
          /rateLimitExceeded|quotaExceeded|backendError/i.test(error.reason)))
    if (!transient || row.attempts >= 8) return false
    const delay = Math.min(300_000, 2000 * 2 ** row.attempts)
    const retryAfter = error instanceof GmailHttpError ? error.retryAfterMs : 0
    this.#db
      .prepare('UPDATE mutation SET attempts = attempts + 1, next_attempt = ? WHERE id = ?')
      .run(this.#now() + Math.max(delay, retryAfter), row.id)
    return true
  }

  #finish(
    row: MutationRow,
    status: MutationResult['status'],
    error: string | null,
    journal?: JournalEntry[],
  ) {
    transaction(this.#db, () => {
      if (journal) {
        const mute =
          row.principal === INTERNAL
            ? this.#committedState(row.thread_id).muted
            : JSON.parse(row.request).kind === 'mute'
        for (const entry of journal) {
          const pending = entry.pending
          if (mute && pending?.change.after[labelId(row.account_id, 'INBOX')] === false)
            this.#store.markMuteSuppressionHandled(pending.change.message_id)
          delete entry.pending
        }
        this.#saveJournal(row, journal)
      }
      this.#db
        .prepare('UPDATE mutation SET status = ?, error = ?, next_attempt = ? WHERE id = ?')
        .run(status, error, this.#now() + 60_000, row.id)
      const statePatch = JSON.parse(row.state_patch) as Partial<ThreadState>
      if (
        status === 'applied' ||
        (row.principal === INTERNAL && statePatch.snoozedUntil === null)
      ) {
        const thread = this.#db
          .prepare('SELECT organise_state FROM thread WHERE id = ?')
          .get(row.thread_id) as { organise_state: string } | undefined
        if (thread)
          this.#db.prepare('UPDATE thread SET organise_state = ? WHERE id = ?').run(
            JSON.stringify({
              ...JSON.parse(thread.organise_state),
              ...statePatch,
            }),
            row.thread_id,
          )
      }
      for (const patch of this.#patches(row.id)) this.#store.refreshMessageLabels(patch.message_id)
      this.#refreshThread(row.thread_id, row.id)
    })
  }
}
