import { randomUUID } from 'node:crypto'
import {
  actionLabels,
  applyLabelPatch,
  type LabelPatch,
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
const PARTIAL_WARNING = 'Gmail may have kept part of the change'
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
  rollback_error: string | null
  rollback_progress: number
  rollback_plan: string | null
  write_journal: string | null
  superseded: string
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
  before: LabelPatch
  after: LabelPatch
}

interface JournalEntry {
  dynamic?: true
  attempted: Change[]
  applied: Change[]
}

interface Step {
  patch: LabelPatch
  trash?: boolean
  changes: Change[]
}

function result(row: MutationRow): MutationResult {
  return {
    id: row.id,
    threadId: row.thread_id,
    status: row.status,
    error: row.error,
    modseq: row.modseq,
    superseded: JSON.parse(row.superseded) as string[],
  }
}

function stepsFor(accountId: string, changes: Change[]): Step[] {
  const trash = labelId(accountId, 'TRASH')
  const inbox = labelId(accountId, 'INBOX')
  const groups = new Map<string, Step>()
  const steps: Step[] = []
  for (const change of changes) {
    const patch = { ...change.after }
    if (trash in patch) {
      const value = Boolean(patch[trash])
      const after: LabelPatch = { [trash]: value }
      if (value && patch[inbox] === false) {
        after[inbox] = false // The Trash endpoint itself removes Inbox.
        delete patch[inbox]
      }
      steps.push({
        patch: after,
        trash: value,
        changes: [{ ...change, after }],
      })
      delete patch[trash]
    }
    if (Object.keys(patch).length === 0) continue
    const key = JSON.stringify(Object.entries(patch).sort())
    let group = groups.get(key)
    if (!group) {
      group = { patch, changes: [] }
      groups.set(key, group)
    }
    group.changes.push({ ...change, after: patch })
  }
  for (const group of groups.values()) {
    for (let start = 0; start < group.changes.length; start += 1000) {
      steps.push({
        patch: group.patch,
        changes: group.changes.slice(start, start + 1000),
      })
    }
  }
  return steps
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

function inverse(account: string, changes: Change[]): Change[] {
  const inbox = labelId(account, 'INBOX')
  const trash = labelId(account, 'TRASH')
  return combine(changes).map(({ message_id, before, after }) => {
    const patch = Object.fromEntries(
      Object.entries(before).filter(([key, value]) => value !== after[key]),
    )
    // Untrash may itself change Inbox. Carry the original value through to a
    // guarded follow-up, even if the original Trash left it unchanged.
    if (patch[trash] === false && inbox in after) patch[inbox] = Boolean(before[inbox])
    return { message_id, before: after, after: patch }
  })
}

function advanceExpected(expected: LabelPatch, change: Change) {
  for (const [key, value] of Object.entries(change.after)) {
    if (expected[key] === change.before[key]) expected[key] = value
  }
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
        "SELECT * FROM mutation WHERE principal = ? AND status = 'failed' AND modseq > ? AND modseq <= ? ORDER BY modseq",
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
      if (target.status === 'applied' && target.prepared !== 1)
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
    // Gmail may adjust Inbox membership as a side effect of trash or untrash.
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
    const state = JSON.parse(original.state_before) as Partial<ThreadState>
    if (state.snoozedUntil && state.snoozedUntil <= this.#now()) {
      Object.assign(state, CLEAR_SNOOZE)
    }
    return state
  }

  #undoChanges(original: MutationRow, state: Partial<ThreadState>): Change[] {
    const snoozed = labelId(original.account_id, SNOOZED_LABEL)
    const inbox = labelId(original.account_id, 'INBOX')
    const trash = labelId(original.account_id, 'TRASH')
    const journal = JSON.parse(original.write_journal ?? '[]') as JournalEntry[]
    const applied =
      original.write_journal === null
        ? this.#patches(original.id)
            .map(fromPatch)
            .map((change) => {
              // v5 did not store the Trash response. It did know that Trash removes Inbox.
              if (change.after[trash]) change.after[inbox] = false
              return change
            })
        : journal.flatMap((entry) => entry.applied)
    return inverse(original.account_id, applied).map((change) => {
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
    const trash = labelId(account, 'TRASH')
    // Resolve the reserved label before converting Gmail IDs into AMC labels.
    if (row.principal === INTERNAL || original || 'snoozedUntil' in JSON.parse(row.state_patch))
      await this.#snoozedLabel(api, account, false)
    const messages = await this.#gmailThread(api, row)
    transaction(this.#db, () => {
      const thread = this.#db
        .prepare('SELECT organise_state FROM thread WHERE id = ?')
        .get(row.thread_id) as { organise_state: string } | undefined
      const state = { ...EMPTY_STATE, ...JSON.parse(thread?.organise_state ?? '{}') } as ThreadState
      let statePatch: Partial<ThreadState>
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
      this.#bumpEpoch(account)
      const found = new Set<string>()
      for (const message of messages) {
        const raw = message.labelIds ?? []
        if (raw.includes('DRAFT')) continue
        const id = messageId(account, message.id)
        found.add(id)
        const labels = this.#store.providerLabels(account, raw)
        const requested = patchFor(id, labels)
        const changesTrash = trash in requested && requested[trash] !== labels.includes(trash)
        const patch = Object.fromEntries(
          Object.entries(requested).filter(
            ([key, present]) =>
              key in (undo.get(id)?.after ?? {}) ||
              present !== labels.includes(key) ||
              (changesTrash && key === inbox),
          ),
        )
        if (Object.keys(patch).length || retainBaseline) {
          const baseline = retainBaseline
            ? { [inbox]: false, [labelId(account, SNOOZED_LABEL)]: false, ...patch }
            : patch
          const before = { ...this.#before(account, baseline, labels), ...undo.get(id)?.before }
          insert.run(row.id, id, JSON.stringify(patch), JSON.stringify(before))
        }
        this.#store.putProviderLabels(account, message.id, raw)
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
         (t.snooze_no_reply = 1 AND EXISTS (
           SELECT 1 FROM message m WHERE m.thread_id = t.id AND m.first_seen_at >= t.snooze_started_at
             AND m.sent_at >= t.snooze_started_at AND
             lower(COALESCE(json_extract(m.from_json, '$.address'), a.address)) != lower(a.address)
         )) AS replied
       FROM thread t JOIN account a ON a.id = t.account_id
       WHERE (t.snoozed_until IS NOT NULL OR t.muted = 1) AND a.status != 'auth_expired'
       AND NOT EXISTS (
         SELECT 1 FROM mutation p WHERE p.thread_id = t.id AND p.principal = ?
           AND (p.status = 'pending' OR (p.status = 'failed' AND p.next_attempt > ?))
       ))
       WHERE snoozed_until <= ? OR replied
          OR account_id || ':INBOX' IN (SELECT value FROM json_each(label_ids))`,
      )
      .all(INTERNAL, now, now) as unknown as (ThreadRow & {
      snoozed_until: number | null
      muted: number
      replied: number
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
          'SELECT id, label_ids FROM message WHERE thread_id = ? ORDER BY sent_at DESC, id DESC',
        )
        .all(thread.id) as { id: string; label_ids: string }[]
      const patches = new Map<string, LabelPatch>()
      for (const row of rows) {
        const labels = JSON.parse(row.label_ids) as string[]
        if (labels.includes(labelId(thread.account_id, 'DRAFT'))) continue
        const patch = sweep(labels)
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
        this.#finish(row, 'failed', row.prepared ? `${message}. ${PARTIAL_WARNING}` : message)
        continue
      }
      const api = this.#api(row.account_id)
      if (!api) {
        const expired = this.#db
          .prepare("SELECT 1 FROM account WHERE id = ? AND status = 'auth_expired'")
          .get(row.account_id)
        if (expired) {
          const message = 'Sign in to Gmail again to organise this Account'
          this.#finish(row, 'failed', row.prepared ? `${message}. ${PARTIAL_WARNING}` : message)
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

  #recordSuperseded(row: MutationRow, id: string) {
    const ids = JSON.parse(row.superseded) as string[]
    if (ids.includes(id)) return
    row.superseded = JSON.stringify([...ids, id])
    this.#db.prepare('UPDATE mutation SET superseded = ? WHERE id = ?').run(row.superseded, row.id)
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

  async #observe(api: GmailApi, row: MutationRow, ids: string[], thread?: GmailMessage[]) {
    const account = row.account_id
    if (!ids.length && !thread?.length) return new Map<string, string[]>()
    const messages = new Map(
      (thread ?? (await this.#gmailThread(api, row))).map((message) => [
        message.id,
        message.labelIds ?? [],
      ]),
    )
    const observed = new Map<string, string[]>(
      thread?.map((message) => [messageId(account, message.id), message.labelIds ?? []]),
    )
    for (const id of ids) {
      const rawId = id.slice(account.length + 1)
      const labels = messages.get(rawId) ?? (await api.getMessageLabels(rawId, true))
      if (labels) observed.set(id, labels)
    }
    return transaction(this.#db, () => {
      this.#bumpEpoch(account)
      return new Map(
        Array.from(observed, ([id, labels]) => {
          this.#store.putProviderLabels(account, id.slice(account.length + 1), labels)
          return [id, this.#store.providerLabels(account, labels)]
        }),
      )
    })
  }

  // All paths use the same guard. Compare the fresh Gmail value with the value this
  // mutation observed or wrote, then send only the remaining delta. Gmail has no
  // compare-and-swap. We accept the window between this read and the provider write,
  // including same-value edits that cannot be attributed to either writer.
  #delta(row: MutationRow, change: Change, labels: string[] | undefined): LabelPatch {
    const patch: LabelPatch = {}
    for (const [key, value] of Object.entries(change.after)) {
      if (labels && labels.includes(key) === change.before[key]) {
        if (value !== change.before[key]) patch[key] = value
      } else {
        this.#recordSuperseded(row, change.message_id)
      }
    }
    return patch
  }

  async #step(
    api: GmailApi,
    row: MutationRow,
    step: Step,
    attempting: (changes: Change[]) => void,
    completed: (changes: Change[]) => void,
    options: { compensating?: boolean; replan?: (messages: GmailMessage[]) => Change[] } = {},
  ) {
    const account = row.account_id
    const inbox = labelId(account, 'INBOX')
    const trash = labelId(account, 'TRASH')
    const spam = labelId(account, 'SPAM')
    const snoozed = labelId(account, SNOOZED_LABEL)
    const rawId = (id: string) => id.slice(account.length + 1)
    const snoozedId =
      snoozed in step.patch
        ? await this.#snoozedLabel(api, account, Boolean(step.patch[snoozed]))
        : null

    // Recheck each actual request, including subgroups created by per-message conflicts.
    let remaining = step.changes
    while (remaining.length || options.replan) {
      const thread = options.replan ? await this.#gmailThread(api, row) : undefined
      if (thread && options.replan) remaining = options.replan(thread)
      const current = await this.#observe(
        api,
        row,
        remaining.map((change) => change.message_id),
        thread,
      )
      const candidates: Change[] = []
      let signature: string | undefined
      const deferred: Change[] = []
      for (const change of remaining) {
        if (
          options.compensating &&
          (JSON.parse(row.superseded) as string[]).includes(change.message_id)
        )
          continue
        const labels = current.get(change.message_id)
        const before = { ...change.before }
        const after = this.#delta(row, change, labels)
        if (!labels) continue
        if (
          options.compensating &&
          (JSON.parse(row.superseded) as string[]).includes(change.message_id)
        )
          continue
        if (step.trash !== undefined) {
          if (!(trash in after)) continue
          // Gmail can change Inbox implicitly. Never send Trash over an Inbox
          // value the mutation did not authorize the endpoint to remove.
          if (labels.includes(inbox) !== before[inbox]) {
            this.#recordSuperseded(row, change.message_id)
            continue
          }
        } else if (after[inbox] && (labels.includes(trash) || labels.includes(spam))) {
          delete after[inbox]
          this.#recordSuperseded(row, change.message_id)
        }
        if (!snoozedId) delete after[snoozed]
        if (!Object.keys(after).length) continue
        const key = JSON.stringify(Object.entries(after).sort())
        signature ??= key
        if (key !== signature) deferred.push(change)
        else candidates.push({ ...change, before, after })
      }
      remaining = deferred
      const first = candidates[0]
      if (!first) break
      const hasMore = deferred.length > 0 || candidates.length > 1000
      candidates.splice(1000)
      attempting(candidates)
      if (step.trash !== undefined) {
        const labels = await api.setTrashed(rawId(first.message_id), step.trash)
        const actual = this.#store.providerLabels(account, labels)
        const after = { [trash]: actual.includes(trash), [inbox]: actual.includes(inbox) }
        transaction(this.#db, () => {
          this.#bumpEpoch(account)
          this.#store.putProviderLabels(account, rawId(first.message_id), labels)
          completed([{ ...first, after }])
        })
        continue
      }
      const add: string[] = []
      const remove: string[] = []
      for (const [key, present] of Object.entries(first.after)) {
        const label = key === snoozed ? snoozedId : rawId(key)
        if (label) (present ? add : remove).push(label)
      }
      await api.batchModify(
        candidates.map((change) => rawId(change.message_id)),
        add,
        remove,
      )
      transaction(this.#db, () => {
        this.#bumpEpoch(account)
        for (const change of candidates) {
          const provider = this.#db
            .prepare('SELECT provider_label_ids FROM message WHERE id = ?')
            .get(change.message_id) as { provider_label_ids: string | null } | undefined
          if (!provider) continue
          const labels = applyLabelPatch(
            JSON.parse(provider.provider_label_ids ?? '[]') as string[],
            change.after,
          )
          this.#db
            .prepare('UPDATE message SET provider_label_ids = ? WHERE id = ?')
            .run(JSON.stringify(labels), change.message_id)
          this.#store.refreshMessageLabels(change.message_id)
        }
        completed(candidates)
      })
      if (!hasMore) break
    }
  }

  #replan(
    row: MutationRow,
    messages: GmailMessage[],
    baseline: Map<string, Change>,
    entry: JournalEntry,
  ): Change[] {
    const account = row.account_id
    const inbox = labelId(account, 'INBOX')
    const marker = labelId(account, SNOOZED_LABEL)
    const archive = row.principal !== INTERNAL
    const applied = new Map(entry.applied.map((change) => [change.message_id, change]))
    const live = new Map(
      messages
        .filter((message) => !message.labelIds?.includes('DRAFT'))
        .map((message) => [
          messageId(account, message.id),
          this.#store.providerLabels(account, message.labelIds ?? []),
        ]),
    )
    const attempted = new Map(entry.attempted.map((change) => [change.message_id, change]))
    for (const [id, change] of attempted) {
      if (!baseline.has(id)) baseline.set(id, change)
    }
    const clearingSnooze = JSON.parse(row.state_patch).snoozedUntil === null
    const changes: Change[] = []
    let wake: string | undefined
    if (!archive) {
      const { replied } = JSON.parse(row.request) as { replied?: boolean }
      const thread = this.#db
        .prepare('SELECT organise_state FROM thread WHERE id = ?')
        .get(row.thread_id) as { organise_state: string } | undefined
      const state = JSON.parse(thread?.organise_state ?? '{}') as Partial<ThreadState>
      const eligible = (labels: string[]) =>
        !labels.includes(labelId(account, 'TRASH')) && !labels.includes(labelId(account, 'SPAM'))
      // A confirmed wake is complete. An ambiguous response also needs no replay
      // while the target is already in Inbox. A vanished target can be replaced.
      const alreadyWoke = entry.attempted.some(({ message_id, after }) => {
        const labels = live.get(message_id)
        return (
          after[inbox] &&
          labels &&
          eligible(labels) &&
          (applied.get(message_id)?.after[inbox] || labels.includes(inbox))
        )
      })
      const markerRemoved = [...live].some(
        ([id, labels]) =>
          eligible(labels) &&
          !labels.includes(marker) &&
          baseline.get(id)?.before[marker] &&
          applied.get(id)?.after[marker] !== false,
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
    for (const [id, labels] of live) {
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
      const before = { ...this.#before(account, after, labels), ...original?.before }
      changes.push({ message_id: id, before, after })
    }
    for (const [id, change] of baseline) {
      if (!live.has(id) && Object.keys(change.after).length) this.#recordSuperseded(row, id)
    }
    // Dispatch the wake before removing markers from the other messages.
    if (wake) changes.sort((a, b) => Number(b.message_id === wake) - Number(a.message_id === wake))
    return changes
  }

  #afterPrior(step: Step, prior: Change[]): Step {
    const previous = new Map(combine(prior).map((change) => [change.message_id, change]))
    return {
      ...step,
      changes: step.changes.map((change) => {
        const last = previous.get(change.message_id)
        const before = { ...change.before }
        if (last) advanceExpected(before, last)
        return { ...change, before }
      }),
    }
  }

  async #write(api: GmailApi, row: MutationRow) {
    const original = row.undo_of ? this.#row(row.undo_of) : undefined
    if (original && (original.status !== 'applied' || original.prepared !== 1)) {
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
    if (
      row.write_journal === null &&
      (row.progress || row.rollback_error || row.attempts || row.prepared === 2)
    ) {
      // Older checkpoints cannot establish what Gmail acknowledged or guard a saved inverse.
      // A preparation retry leaves prepared unset and can still safely start a new plan.
      await this.#observe(
        api,
        row,
        this.#patches(row.id).map((patch) => patch.message_id),
      ).catch(() => {})
      this.#finish(row, 'failed', `Gmail writeback predates guarded replay. ${PARTIAL_WARNING}`)
      return
    }
    const journal = JSON.parse(row.write_journal ?? '[]') as JournalEntry[]
    if (row.rollback_error) {
      await this.#rollback(api, row, journal)
      return
    }
    const changes = this.#patches(row.id).map(fromPatch)
    const dynamic =
      (journal[0]?.dynamic || (!row.progress && !journal.length)) &&
      (row.principal === INTERNAL
        ? JSON.parse(row.state_patch).snoozedUntil === null
        : JSON.parse(row.request).kind === 'archive')
    const steps: Step[] = dynamic
      ? [{ patch: { [labelId(row.account_id, SNOOZED_LABEL)]: false }, changes }]
      : stepsFor(row.account_id, changes)
    const baseline = new Map(changes.map((change) => [change.message_id, change]))
    let progress = row.progress
    try {
      for (; progress < steps.length; progress++) {
        const step = steps[progress]
        if (!step) break
        const prior = journal.slice(0, progress).flatMap((entry) => entry.applied)
        const entry = journal[progress] ?? { attempted: [], applied: [] }
        if (dynamic) entry.dynamic = true
        journal[progress] = entry
        const completedIds = new Set(entry.applied.map((change) => change.message_id))
        const remaining = {
          ...step,
          changes: step.changes.filter((change) => !completedIds.has(change.message_id)),
        }
        await this.#step(
          api,
          row,
          this.#afterPrior(remaining, prior),
          (changes) => {
            entry.attempted = combine([...entry.attempted, ...changes])
            this.#saveJournal(row, journal)
          },
          (changes) => {
            entry.applied = combine([...entry.applied, ...changes])
            this.#saveJournal(row, journal)
          },
          dynamic ? { replan: (messages) => this.#replan(row, messages, baseline, entry) } : {},
        )
        transaction(this.#db, () => {
          this.#saveJournal(row, journal)
          this.#db
            .prepare('UPDATE mutation SET progress = ? WHERE id = ?')
            .run(progress + 1, row.id)
        })
      }
    } catch (error) {
      if (this.#retry(row, error)) return
      const message =
        error instanceof GmailHttpError
          ? `Gmail refused the change (HTTP ${error.status})`
          : error instanceof OAuthError && error.needsReauth
            ? 'Sign in to Gmail again to organise this Account'
            : 'Could not write the change to Gmail'
      row.rollback_error = message
      row.attempts = 0
      this.#db
        .prepare(
          'UPDATE mutation SET rollback_error = ?, attempts = 0, next_attempt = 0 WHERE id = ?',
        )
        .run(message, row.id)
      await this.#rollback(api, row, journal)
      return
    }
    this.#saveJournal(row, journal)
    this.#finish(row, 'applied', null)
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

  async #rollback(api: GmailApi, row: MutationRow, journal: JournalEntry[]) {
    let message = row.rollback_error ?? 'Gmail writeback failed'
    const trash = labelId(row.account_id, 'TRASH')
    const acknowledged = inverse(
      row.account_id,
      journal.flatMap((entry) => entry.applied),
    )
    const allowed = new Map(acknowledged.map((change) => [change.message_id, change.after]))
    try {
      let rollback: Change[]
      if (row.rollback_plan === null) {
        const uncertain = journal.flatMap((entry) => {
          const applied = new Set(entry.applied.map((change) => change.message_id))
          return entry.attempted.filter((change) => !applied.has(change.message_id))
        })
        const current = await this.#observe(api, row, [
          ...new Set(uncertain.map((change) => change.message_id)),
        ])
        for (const change of uncertain) {
          const labels = current.get(change.message_id)
          if (
            !labels ||
            Object.entries(change.before).some(([key, value]) => labels.includes(key) !== value)
          ) {
            this.#recordSuperseded(row, change.message_id)
          }
          const touched =
            trash in change.after
              ? [[trash, change.after[trash]] as const]
              : Object.entries(change.after)
          if (labels && touched.some(([key, value]) => labels.includes(key) === value)) {
            if (!message.includes(PARTIAL_WARNING)) message += `. ${PARTIAL_WARNING}`
          }
        }
        this.#db.prepare('UPDATE mutation SET rollback_error = ? WHERE id = ?').run(message, row.id)
        rollback = acknowledged
        row.rollback_plan = JSON.stringify(rollback)
        this.#db
          .prepare('UPDATE mutation SET rollback_plan = ? WHERE id = ?')
          .run(row.rollback_plan, row.id)
      } else {
        rollback = JSON.parse(row.rollback_plan) as Change[]
      }
      const steps = stepsFor(row.account_id, rollback)
      for (let index = row.rollback_progress; index < steps.length; index++) {
        const step = steps[index]
        if (!step) break
        await this.#step(
          api,
          row,
          {
            ...step,
            changes: step.changes.filter((change) =>
              Object.entries(change.after).every(
                ([key, value]) => allowed.get(change.message_id)?.[key] === value,
              ),
            ),
          },
          () => {},
          (changes) => {
            // Persist provider side effects as the expectations for subsequent steps.
            for (const change of changes) {
              const target = rollback.find((entry) => entry.message_id === change.message_id)
              if (target) advanceExpected(target.before, change)
            }
            this.#db
              .prepare('UPDATE mutation SET rollback_plan = ? WHERE id = ?')
              .run(JSON.stringify(rollback), row.id)
          },
          { compensating: true },
        )
        // Keep the step layout stable. The guards neutralize completed subgroups
        // if the process stops between their response and the step checkpoint.
        for (const next of steps.slice(index + 1)) {
          for (const change of next.changes) {
            Object.assign(
              change.before,
              rollback.find((entry) => entry.message_id === change.message_id)?.before,
            )
          }
        }
        this.#db
          .prepare('UPDATE mutation SET rollback_progress = ? WHERE id = ?')
          .run(index + 1, row.id)
      }
    } catch (error) {
      if (this.#retry(row, error)) return
      if (!message.includes(PARTIAL_WARNING)) message += `. ${PARTIAL_WARNING}`
      const ids = journal.flatMap((entry) => entry.attempted.map((change) => change.message_id))
      await this.#observe(api, row, [...new Set(ids)]).catch(() => {})
    }
    this.#finish(row, 'failed', message)
  }

  #finish(row: MutationRow, status: MutationResult['status'], error: string | null) {
    transaction(this.#db, () => {
      this.#db
        .prepare('UPDATE mutation SET status = ?, error = ?, next_attempt = ? WHERE id = ?')
        .run(status, error, this.#now() + 60_000, row.id)
      if (status === 'applied') {
        const thread = this.#db
          .prepare('SELECT organise_state FROM thread WHERE id = ?')
          .get(row.thread_id) as { organise_state: string } | undefined
        if (thread)
          this.#db.prepare('UPDATE thread SET organise_state = ? WHERE id = ?').run(
            JSON.stringify({
              ...JSON.parse(thread.organise_state),
              ...JSON.parse(row.state_patch),
            }),
            row.thread_id,
          )
      }
      for (const patch of this.#patches(row.id)) this.#store.refreshMessageLabels(patch.message_id)
      this.#refreshThread(row.thread_id, row.id)
    })
  }
}
