import { randomUUID } from 'node:crypto'
import {
  type AgentMutationResult,
  actionLabels,
  imapActionError,
  imapActionLabels,
  type LabelPatch,
  type MutationMessageResult,
  type MutationRequest,
  type MutationResult,
  type OrganiseAction,
  SNOOZED_LABEL,
} from '@amc/protocol'
import { agentGrantActive } from '../auth/tokens.ts'
import { transaction } from '../db/database.ts'
import type { Logger } from '../log.ts'
import { GmailHttpError } from '../providers/gmail/http.ts'
import { OAuthError } from '../providers/gmail/oauth.ts'
import type {
  GmailApi,
  GmailHistoryRecord,
  GmailMessage,
  GmailMessageState,
} from '../providers/gmail/types.ts'
import type { MessageLocation } from '../providers/imap/locations.ts'
import {
  executeImap,
  IMAP_COPY_INCOMPLETE,
  IMAP_UNDO_UNVERIFIED,
  type ImapChange,
  type ImapJournalEntry,
  type ImapMutationRunner,
  imapLocationRevision,
} from '../providers/imap/organise.ts'
import { labelId, type MailStore, messageId } from './store.ts'

const INTERNAL = 'engine'
const CLEAR_SNOOZE = { snoozedUntil: null, noReply: false, startedAt: null, snoozeIntent: null }

interface ThreadState {
  muted: boolean
  snoozedUntil: number | null
  noReply: boolean
  startedAt: number | null
  snoozeIntent: string | null
  muteIntent: string | null
}
const EMPTY_STATE: ThreadState = {
  muted: false,
  snoozedUntil: null,
  noReply: false,
  startedAt: null,
  snoozeIntent: null,
  muteIntent: null,
}

interface ThreadRow {
  id: string
  account_id: string
  organise_state: string
  kind: string
}

interface MutationRow {
  seq: number
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
  intent_id: string | null
  undo_of: string | null
  agent_action_id: string | null
  agent_message_ids: string
}

interface Intent {
  id: string
  history_id: string
  checked_history_id: string
  marker_id: string | null
  status: 'active' | 'done' | 'superseded'
}

interface AutomaticRequest {
  work: 'suppress' | 'wake'
  replied: boolean
  snooze: boolean
  checkThrough: string
  cancelled?: boolean
}

interface PatchRow {
  message_id: string
  patch: string
  before: string
  revisions: string
}

interface Change {
  message_id: string
  before: Record<string, boolean | null>
  after: LabelPatch
  revisions?: Record<string, string>
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
  wakeConsumed?: boolean
  intentSuperseded?: boolean
}

interface ProviderObservation {
  labels: string[]
  historyId: string | undefined
}

interface LabelEvent {
  revision: string
  label: string
  present: boolean
}

interface HistorySnapshot {
  records: GmailHistoryRecord[]
  watermark: string
}

interface MessageHistory {
  events: LabelEvent[]
  deleted: boolean
  delivered: boolean
}

interface Step {
  patch: LabelPatch
  trash?: boolean
  changes: Change[]
}

function readJournal(row: MutationRow): JournalEntry[] {
  return JSON.parse(row.write_journal ?? '[]') as JournalEntry[]
}

function acknowledgedLabels(journal: JournalEntry[]): Set<string> {
  return new Set(
    journal.flatMap(({ applied }) =>
      applied.flatMap(({ message_id, revisions }) =>
        Object.entries(revisions ?? {}).map(([label, revision]) =>
          JSON.stringify([message_id, label, revision]),
        ),
      ),
    ),
  )
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
    revisions: JSON.parse(row.revisions),
  }
}

function combine(changes: Change[]): Change[] {
  const combined = new Map<string, Change>()
  for (const { message_id, before, after, revisions } of changes) {
    const entry = combined.get(message_id) ?? { message_id, before: {}, after: {}, revisions: {} }
    for (const [key, present] of Object.entries(after)) {
      if (!(key in entry.before)) entry.before[key] = Boolean(before[key])
      entry.after[key] = present
      const revision = revisions?.[key]
      if (revision) {
        entry.revisions ??= {}
        entry.revisions[key] = revision
      }
    }
    combined.set(message_id, entry)
  }
  return [...combined.values()]
}

function inverse(changes: Change[]): Change[] {
  return combine(changes).map(({ message_id, before, after, revisions }) => ({
    message_id,
    before: after,
    revisions,
    after: Object.fromEntries(
      Object.entries(before).map(([label, value]) => [label, Boolean(value)]),
    ),
  }))
}

export const SNOOZE_DISABLED = 'Snooze is disabled on this Engine'

const GRANT_EXPIRED = 'Agent grant expired'

export class MutationError extends Error {}
export class MutationPermissionError extends MutationError {}

export class Mutations {
  readonly #store: MailStore
  readonly #api: (accountId: string) => GmailApi | null
  readonly #log: Logger
  readonly #imap: ImapMutationRunner | undefined
  readonly #now: () => number
  readonly snoozeEnabled: boolean
  readonly #running = new Map<string, Promise<void>>()
  #timer: ReturnType<typeof setInterval> | undefined

  constructor(
    store: MailStore,
    api: (accountId: string) => GmailApi | null,
    log: Logger,
    {
      now = Date.now,
      snoozeEnabled = false,
      imap,
    }: {
      now?: () => number
      snoozeEnabled?: boolean
      imap?: ImapMutationRunner
    } = {},
  ) {
    this.#store = store
    this.#api = api
    this.#log = log
    this.#imap = imap
    this.#now = now
    this.snoozeEnabled = snoozeEnabled
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

  agentResults(actionId: string): AgentMutationResult[] {
    const rows = this.#db
      .prepare('SELECT * FROM mutation WHERE agent_action_id = ? ORDER BY seq')
      .all(actionId) as unknown as MutationRow[]
    return rows.map((row) => {
      const outcome = result(row)
      const messages = new Map<string, AgentMutationResult['messages'][number]>(
        outcome.messages?.map((message) => [message.messageId, message]),
      )
      for (const messageId of JSON.parse(row.agent_message_ids) as string[]) {
        if (messages.has(messageId)) continue
        messages.set(messageId, {
          messageId,
          status:
            row.status === 'applied'
              ? 'unchanged'
              : row.status === 'partial'
                ? 'failed'
                : row.status,
          appliedLabels: [],
          failedLabels: [],
          supersededLabels: [],
        })
      }
      const undo = this.#agentUndoFor(row.id)
      return { ...outcome, messages: [...messages.values()], undo: undo ? result(undo) : null }
    })
  }

  #agentUndoFor(id: string): MutationRow | undefined {
    return this.#db
      .prepare('SELECT * FROM mutation WHERE undo_of = ? ORDER BY seq DESC LIMIT 1')
      .get(id) as MutationRow | undefined
  }

  undoAgentAction(owner: string, actionId: string): MutationResult[] {
    return transaction(this.#db, () => {
      const targets = this.#db
        .prepare(`
        SELECT * FROM mutation WHERE agent_action_id = ? AND status != 'failed' ORDER BY seq DESC
      `)
        .all(actionId) as unknown as MutationRow[]
      if (!targets.length) {
        const action = this.#db.prepare('SELECT tool FROM agent_action WHERE id = ?').get(actionId)
        if (action?.tool === 'set_bucket')
          throw new MutationError(
            'Bucket Undo is unavailable because its previous assignment was not recorded',
          )
        throw new MutationError('This action has no changes to undo')
      }
      return targets.map((target) => {
        const existing = this.#agentUndoFor(target.id)
        if (existing && existing.status !== 'failed') return result(existing)
        return this.#submit(
          owner,
          { id: randomUUID(), action: { kind: 'undo', mutationId: target.id } },
          false,
          target,
        )
      })
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

  #isSnooze(row: MutationRow): boolean {
    const { kind, snooze } = JSON.parse(row.request)
    const original = row.undo_of ? this.#row(row.undo_of) : undefined
    return (
      kind === 'snooze' ||
      snooze === true ||
      (original !== undefined && JSON.parse(original.request).kind === 'snooze')
    )
  }

  #thread(id: string | undefined): ThreadRow {
    const thread = this.#db
      .prepare(
        'SELECT t.id, t.account_id, t.organise_state, a.kind FROM thread t JOIN account a ON a.id = t.account_id WHERE t.id = ?',
      )
      .get(id ?? '') as ThreadRow | undefined
    if (!thread) throw new MutationError('Thread is no longer available')
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

  #submit(
    principal: string,
    request: MutationRequest,
    allowTrash: boolean,
    agentUndoTarget?: MutationRow,
  ): MutationResult {
    const action = request.action
    if (!this.snoozeEnabled && action.kind === 'snooze') throw new MutationError(SNOOZE_DISABLED)
    if (action.kind === 'trash' && !allowTrash)
      throw new MutationPermissionError('Only the owner can move mail to or from Trash')
    const existing = this.#row(request.id)
    const body = JSON.stringify(request.action)
    if (existing) {
      if (existing.principal !== principal || existing.request !== body) {
        throw new MutationError('Mutation id is already in use')
      }
      if (!this.snoozeEnabled && this.#isSnooze(existing)) throw new MutationError(SNOOZE_DISABLED)
      return result(existing)
    }

    if (action.kind === 'undo') {
      const target =
        agentUndoTarget ??
        (this.#db
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
          ) as MutationRow | undefined)
      if (!target || (action.mutationId && target.id !== action.mutationId)) {
        throw new MutationError('There is no matching action to undo')
      }
      const targetKind = JSON.parse(target.request).kind
      if (!this.snoozeEnabled && targetKind === 'snooze') throw new MutationError(SNOOZE_DISABLED)
      if (!allowTrash && targetKind === 'trash')
        throw new MutationPermissionError('Only the owner can undo changes to Trash')
      if (target.status !== 'pending' && target.prepared !== 1)
        throw new MutationError('This action predates verified Gmail undo')
      const thread = this.#thread(target.thread_id)
      const stateError = this.#undoStateError(target, request.id)
      if (stateError) throw new MutationError(stateError)
      if (thread.kind === 'imap' && !this.#hasVerifiedImapUndo(target))
        throw new MutationError(IMAP_UNDO_UNVERIFIED)
      const state = this.#undoState(target, this.#state(thread))
      const changes = this.#undoChanges(target)
      if (!allowTrash && thread.kind === 'imap') {
        const trash = this.#imapTrashLabels(thread.account_id)
        if (changes.some(({ after }) => Object.keys(after).some((id) => trash.has(id))))
          throw new MutationPermissionError('Only the owner can undo changes to Trash')
      }
      const inverses = new Map(changes.map((change) => [change.message_id, change.after]))
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
    if (thread.kind === 'imap') {
      const labels = this.#db
        .prepare('SELECT id FROM label WHERE account_id = ?')
        .all(thread.account_id) as { id: string }[]
      const account = this.#db
        .prepare('SELECT cursor FROM account WHERE id = ?')
        .get(thread.account_id) as { cursor: string }
      const { imapMoves } = JSON.parse(account.cursor) as { imapMoves?: boolean }
      const error = imapActionError(
        action,
        thread.account_id,
        new Set(labels.map(({ id }) => id)),
        imapMoves,
      )
      if (error) throw new MutationError(error)
    }
    if (action.kind === 'label') {
      if (
        thread.kind === 'imap' &&
        !allowTrash &&
        action.value &&
        this.#imapTrashLabels(thread.account_id).has(action.labelId)
      )
        throw new MutationPermissionError('Only the owner can move mail to or from Trash')
      const allowed = this.#db
        .prepare(
          "SELECT 1 FROM label WHERE id = ? AND account_id = ? AND kind = 'user' AND name != ?",
        )
        .get(action.labelId, thread.account_id, SNOOZED_LABEL)
      if (!allowed) throw new MutationError('Choose a user Label from this Account')
    }
    if (action.kind === 'snooze' && action.until <= this.#now())
      throw new MutationError('Choose a time in the future')
    const { patch, statePatch } = this.#actionPatch(
      action,
      thread.account_id,
      this.#state(thread),
      request.id,
    )
    return this.#insert(request.id, principal, body, thread, statePatch, (_, labels) =>
      thread.kind === 'imap' ? imapActionLabels(action, thread.account_id, labels) : patch,
    )
  }

  #actionPatch(
    action: Exclude<OrganiseAction, { kind: 'undo' }>,
    account: string,
    state: ThreadState,
    intentId: string,
    startedAt = this.#now(),
  ) {
    const patch = actionLabels(action, account)
    const statePatch: Partial<ThreadState> = {}
    if (action.kind === 'snooze') {
      Object.assign(statePatch, {
        snoozeIntent: intentId,
        snoozedUntil: action.until,
        noReply: action.noReply ?? false,
        startedAt,
      })
      patch[labelId(account, SNOOZED_LABEL)] = true
    }
    if (action.kind === 'mute') {
      statePatch.muted = action.value
      statePatch.muteIntent = action.value ? intentId : null
    }
    if (action.kind !== 'snooze' && state.snoozedUntil !== null) {
      Object.assign(statePatch, CLEAR_SNOOZE)
    }
    return { patch, statePatch }
  }

  #insert(
    id: string,
    principal: string,
    body: string,
    thread: ThreadRow,
    statePatch: Partial<ThreadState>,
    patchFor: (messageId: string, labels: string[]) => LabelPatch,
    undoOf: string | null = null,
    intentId: string | null = null,
  ): MutationResult {
    const state = this.#state(thread)
    const stateBefore = Object.fromEntries(
      Object.keys(statePatch).map((key) => [key, state[key as keyof ThreadState]]),
    )
    this.#db
      .prepare(
        'INSERT INTO mutation (id, principal, account_id, thread_id, request, state_patch, state_before, undo_of, intent_id) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?)',
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
        intentId,
      )
    const rows = this.#db
      .prepare('SELECT id, label_ids, unread, starred FROM message WHERE thread_id = ? ORDER BY id')
      .all(thread.id) as { id: string; label_ids: string; unread: number; starred: number }[]
    for (const row of rows) {
      const labels = JSON.parse(row.label_ids) as string[]
      if (labels.includes(labelId(thread.account_id, 'DRAFT'))) continue
      const patch = patchFor(row.id, labels)
      if (Object.keys(patch).length === 0) continue
      if (thread.kind === 'imap') {
        const locations = this.#db
          .prepare('SELECT * FROM imap_location WHERE message_id = ?')
          .all(row.id) as unknown as MessageLocation[]
        const [source] = locations
        const revisions =
          locations.length === 1 && source && labels.includes(source.label_id)
            ? Object.fromEntries(Object.keys(patch).map((id) => [id, imapLocationRevision(source)]))
            : {}
        const before = {
          ...Object.fromEntries(labels.map((id) => [id, true])),
          ...Object.fromEntries(Object.keys(patch).map((id) => [id, labels.includes(id)])),
          [labelId(thread.account_id, 'UNREAD')]: Boolean(row.unread),
          [labelId(thread.account_id, 'STARRED')]: Boolean(row.starred),
        }
        this.#db
          .prepare('INSERT INTO mutation_message VALUES (?, ?, ?, ?, ?)')
          .run(id, row.id, JSON.stringify(patch), JSON.stringify(before), JSON.stringify(revisions))
        this.#store.refreshMessageLabels(row.id)
        continue
      }
      const before = this.#before(thread.account_id, patch, labels)
      // Preserve the pre-M3 label baseline even if the message has never been refreshed from Gmail.
      this.#db
        .prepare(
          'UPDATE message SET provider_label_ids = label_ids WHERE id = ? AND provider_label_ids IS NULL',
        )
        .run(row.id)
      this.#db
        .prepare(
          'INSERT INTO mutation_message (mutation_id, message_id, patch, before) VALUES (?, ?, ?, ?)',
        )
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

  #imapTrashLabels(accountId: string): Set<string> {
    const account = this.#db.prepare('SELECT cursor FROM account WHERE id = ?').get(accountId)
    const { imapTrashLabels = [] } = JSON.parse(String(account?.cursor ?? '{}')) as {
      imapTrashLabels?: string[]
    }
    return new Set(['TRASH', ...imapTrashLabels].map((id) => labelId(accountId, id)))
  }

  #undoStateError(original: MutationRow, undoId: string): string | undefined {
    const { kind } = JSON.parse(original.request)
    if (kind !== 'mute' && kind !== 'snooze') return
    const field = kind === 'mute' ? 'muted' : 'snoozeIntent'
    const newer = this.#db
      .prepare(`
      SELECT 1 FROM mutation
      WHERE thread_id = ? AND seq > ? AND id != ? AND status IN ('applied', 'pending')
        AND json_type(state_patch, ?) IS NOT NULL
      LIMIT 1
    `)
      .get(original.thread_id, original.seq, undoId, `$.${field}`)
    if (newer)
      return kind === 'mute'
        ? 'Undo unavailable: Mute has changed since this action'
        : 'Undo unavailable: Snooze has changed since this action'
  }

  #hasVerifiedImapUndo(original: MutationRow): boolean {
    const { kind } = JSON.parse(original.request)
    if (!['archive', 'trash', 'label'].includes(kind)) return true
    const moves: ImapChange[] = readJournal(original).flatMap((entry) => entry.applied)
    return (
      moves.length > 0 &&
      moves.every(
        ({ moveFrom, revisions }) => moveFrom && Object.values(revisions ?? {}).some(Boolean),
      )
    )
  }

  #undoState(original: MutationRow, current: ThreadState): Partial<ThreadState> {
    const state: Partial<ThreadState> =
      current.snoozeIntent === original.id ? { ...CLEAR_SNOOZE } : {}
    if (original.status !== 'partial') {
      const { muted, muteIntent } = JSON.parse(original.state_before) as Partial<ThreadState>
      if (muted !== undefined) state.muted = muted
      if (muteIntent !== undefined) state.muteIntent = muteIntent
    }
    return state
  }

  #undoChanges(original: MutationRow): Change[] {
    const snoozed = labelId(original.account_id, SNOOZED_LABEL)
    const applied =
      original.status === 'pending'
        ? this.#patches(original.id).map(fromPatch)
        : readJournal(original).flatMap((entry) => entry.applied)
    return inverse(applied).map((change) => {
      delete change.after[snoozed]
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
    return (labels: string[], ownsMarker: boolean): LabelPatch => {
      const patch: LabelPatch = {}
      if (exiting && ownsMarker && labels.includes(snoozedLabel)) patch[snoozedLabel] = false
      if (labels.includes(trash) || labels.includes(spam)) return patch
      if (wake) {
        patch[inbox] = true
        wake = false
      } else if (!exiting && (muted || snoozed) && labels.includes(inbox)) {
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
    const action = JSON.parse(row.request) as Exclude<OrganiseAction, { kind: 'undo' }>
    const startsIntent = action.kind === 'snooze' || (action.kind === 'mute' && action.value)
    // Take the action's checkpoint before its first read. Acknowledgements later
    // identify our exact changes without hiding an intervening edit on a sibling.
    const checkpoint = startsIntent ? (await api.profile()).historyId : undefined
    if (startsIntent && !checkpoint) throw new Error('Gmail did not provide a history checkpoint')
    const messages = await this.#gmailThread(api, row)
    transaction(this.#db, () => {
      const state = this.#committedState(row.thread_id)
      let statePatch: Partial<ThreadState>
      let patchFor: (id: string, labels: string[]) => LabelPatch
      const undo = new Map<string, Change>()
      if (original) {
        statePatch = this.#undoState(original, state)
        for (const change of this.#undoChanges(original)) undo.set(change.message_id, change)
        patchFor = (id) => undo.get(id)?.after ?? {}
      } else if (row.intent_id) {
        const { work, snooze, replied, cancelled } = JSON.parse(row.request) as AutomaticRequest
        const exiting = work === 'wake'
        statePatch = exiting && !cancelled ? CLEAR_SNOOZE : {}
        const sweep = this.#snoozeSweep(
          account,
          state.muted,
          snooze,
          exiting,
          replied || !!cancelled,
        )
        const scoped = new Set(this.#intentMessages(row.intent_id, work))
        messages.sort(
          (a, b) =>
            Number(b.internalDate ?? 0) - Number(a.internalDate ?? 0) || b.id.localeCompare(a.id),
        )
        const intent = this.#intent(row.intent_id)
        const markers =
          exiting && intent
            ? this.#markerMessages(account, intent, this.#intentJournals(intent.id, row.id))
            : new Set<string>()
        patchFor = (id, labels) => (exiting || scoped.has(id) ? sweep(labels, markers.has(id)) : {})
      } else {
        const { startedAt } = JSON.parse(row.state_patch) as Partial<ThreadState>
        const planned = this.#actionPatch(action, account, state, row.id, startedAt ?? undefined)
        statePatch = planned.statePatch
        patchFor = () => planned.patch
      }
      const stateBefore = Object.fromEntries(
        Object.keys(statePatch).map((key) => [key, state[key as keyof ThreadState]]),
      )
      const snoozeExit = this.#isSnoozeExit(row)
      const retainBaseline = snoozeExit || (!original && action.kind === 'archive')
      const projected = this.#patches(row.id)
      this.#db.prepare('DELETE FROM mutation_message WHERE mutation_id = ?').run(row.id)
      const insert = this.#db.prepare('INSERT INTO mutation_message VALUES (?, ?, ?, ?, ?)')
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
        const patch = Object.fromEntries(
          Object.entries(requested).filter(
            ([key, present]) =>
              key in (undo.get(id)?.after ?? {}) || present !== labels.includes(key),
          ),
        )
        if (Object.keys(patch).length || retainBaseline) {
          const baseline = { ...patch }
          if (retainBaseline) baseline[inbox] ??= false
          if (snoozeExit) baseline[labelId(account, SNOOZED_LABEL)] ??= false
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
          const revisions = original
            ? undo.get(id)?.revisions
            : this.#revisions(before, observed.historyId)
          insert.run(
            row.id,
            id,
            JSON.stringify(patch),
            JSON.stringify(before),
            JSON.stringify(revisions ?? {}),
          )
        }
      }
      for (const [id, change] of undo) {
        if (found.has(id) || !Object.keys(change.after).length) continue
        // A Trash message may be omitted from the thread response. Verify it individually.
        insert.run(
          row.id,
          id,
          JSON.stringify(change.after),
          JSON.stringify(change.before),
          JSON.stringify(change.revisions ?? {}),
        )
      }
      if (checkpoint) {
        this.#db
          .prepare(
            'INSERT INTO organise_intent (id, account_id, history_id, checked_history_id, marker_id) VALUES (?, ?, ?, ?, ?)',
          )
          .run(
            row.id,
            account,
            checkpoint,
            checkpoint,
            action.kind === 'snooze' ? (this.#snoozedLabel(account) ?? null) : null,
          )
        const seen = this.#db.prepare(
          "INSERT INTO organise_intent_message VALUES (?, ?, 'suppress', 'done')",
        )
        for (const id of found) seen.run(row.id, id)
      }
      for (const patch of projected) this.#store.refreshMessageLabels(patch.message_id)
      row.prepared = 1
      row.write_journal = '[]'
      row.state_patch = JSON.stringify(statePatch)
      row.state_before = JSON.stringify(stateBefore)
      this.#db
        .prepare(
          'UPDATE mutation SET prepared = 1, write_journal = ?, state_patch = ?, state_before = ? WHERE id = ?',
        )
        .run(row.write_journal, row.state_patch, row.state_before, row.id)
      this.#refreshThread(row.thread_id, row.id)
    })
  }

  #isSnoozeExit(row: MutationRow): boolean {
    return (
      row.principal === INTERNAL && (JSON.parse(row.request) as AutomaticRequest).work === 'wake'
    )
  }

  #intent(id: string): Intent | undefined {
    return this.#db.prepare('SELECT * FROM organise_intent WHERE id = ?').get(id) as
      | Intent
      | undefined
  }

  #intentMessages(id: string, work: AutomaticRequest['work']): string[] {
    const rows = this.#db
      .prepare(
        "SELECT message_id FROM organise_intent_message WHERE intent_id = ? AND work = ? AND status = 'pending'",
      )
      .all(id, work) as { message_id: string }[]
    return rows.map(({ message_id }) => message_id)
  }

  #trackIntentMessage(id: string, messageId: string, work: AutomaticRequest['work']) {
    this.#db
      .prepare("INSERT OR IGNORE INTO organise_intent_message VALUES (?, ?, ?, 'pending')")
      .run(id, messageId, work)
  }

  #schedule() {
    const now = this.#now()
    const candidates = this.#db
      .prepare(
        `SELECT t.id, t.account_id, t.organise_state, t.snoozed_until, t.muted,
         a.kind, json_extract(a.cursor, '$.historyId') AS history_cursor,
         (?1 AND t.snooze_no_reply = 1 AND EXISTS (
           SELECT 1 FROM message m WHERE m.thread_id = t.id AND m.first_seen_at >= t.snooze_started_at
             AND m.sent_at >= t.snooze_started_at AND
             lower(COALESCE(json_extract(m.from_json, '$.address'), a.address)) != lower(a.address)
         )) AS replied
         FROM thread t JOIN account a ON a.id = t.account_id
         WHERE a.kind = 'gmail' AND a.status != 'auth_expired'
           AND ((?1 AND t.snoozed_until IS NOT NULL) OR t.muted = 1)
         AND NOT EXISTS (
           SELECT 1 FROM mutation p WHERE p.thread_id = t.id AND p.status = 'pending'
         )`,
      )
      .all(Number(this.snoozeEnabled)) as unknown as (ThreadRow & {
      snoozed_until: number | null
      muted: number
      replied: number
      history_cursor: string | null
    })[]
    for (const thread of candidates) {
      const state = this.#committedState(thread.id)
      const snooze = this.snoozeEnabled && thread.snoozed_until !== null
      const intentId = snooze ? state.snoozeIntent : state.muteIntent
      const intent = intentId ? this.#intent(intentId) : undefined
      if (intent?.status !== 'active') continue
      const replied = Boolean(thread.replied)
      const exiting = snooze && (Number(thread.snoozed_until) <= now || replied)
      const work = exiting ? 'wake' : 'suppress'
      const sweep = this.#snoozeSweep(
        thread.account_id,
        Boolean(thread.muted),
        snooze,
        exiting,
        replied,
      )
      const rows = this.#db
        .prepare(
          `SELECT m.id, m.label_ids, m.provider_history_id, w.status
           FROM message m LEFT JOIN organise_intent_message w
             ON w.intent_id = ? AND w.message_id = m.id AND w.work = ?
           WHERE m.thread_id = ? ORDER BY m.sent_at DESC, m.id DESC`,
        )
        .all(intent.id, work, thread.id) as {
        id: string
        label_ids: string
        provider_history_id: string | null
        status: string | null
      }[]
      const patches = new Map<string, LabelPatch>()
      const markers = exiting
        ? this.#markerMessages(thread.account_id, intent, this.#intentJournals(intent.id))
        : new Set<string>()
      let checkThrough = intent.checked_history_id
      for (const row of rows) {
        const revision = row.provider_history_id
        if (revision && !this.#historyIncludes(checkThrough, revision)) checkThrough = revision
        const labels = JSON.parse(row.label_ids) as string[]
        if (row.status || labels.includes(labelId(thread.account_id, 'DRAFT'))) continue
        if (!exiting && !this.#historyIncludes(thread.history_cursor, revision ?? undefined))
          continue
        const patch = sweep(labels, markers.has(row.id))
        if (Object.keys(patch).length) patches.set(row.id, patch)
      }
      if (exiting || patches.size || (snooze && checkThrough !== intent.checked_history_id)) {
        for (const id of patches.keys()) this.#trackIntentMessage(intent.id, id, work)
        const request: AutomaticRequest = { work, replied, snooze, checkThrough }
        this.#insert(
          randomUUID(),
          INTERNAL,
          JSON.stringify(request),
          thread,
          exiting ? CLEAR_SNOOZE : {},
          (id) => patches.get(id) ?? {},
          null,
          intent.id,
        )
      }
    }
  }

  async tick(): Promise<void> {
    transaction(this.#db, () => this.#schedule())
    const now = this.#now()
    const rows = this.#db
      .prepare(
        `SELECT m.*, a.kind, a.status AS account_status FROM mutation m JOIN account a ON a.id = m.account_id JOIN (
        SELECT MIN(seq) AS seq FROM mutation WHERE status = 'pending' GROUP BY account_id
       ) head ON head.seq = m.seq WHERE m.next_attempt <= ?`,
      )
      .all(now) as unknown as (MutationRow & { kind: string; account_status: string })[]
    const started: Promise<void>[] = []
    for (const row of rows) {
      if (this.#running.has(row.account_id)) continue
      if (!this.snoozeEnabled && this.#isSnooze(row)) {
        this.#finish(row, 'failed', SNOOZE_DISABLED, undefined, { discard: true })
        continue
      }
      const nonOwner = this.#db
        .prepare("SELECT 1 FROM token WHERE id = ? AND kind NOT IN ('desktop', 'cli')")
        .get(row.principal)
      if (!row.agent_action_id && nonOwner) {
        const message = 'Organise requires a paired owner Client'
        this.#finish(row, 'failed', message)
        continue
      }
      if (row.agent_action_id && !this.#agentGrantActive(row)) {
        this.#stopAgentWrite(row, readJournal(row))
        continue
      }
      if (row.kind === 'imap') {
        if (row.account_status === 'auth_expired') {
          this.#finish(row, 'failed', 'Sign in to IMAP again to organise this Account')
        } else {
          const task = this.#writeImap(row).finally(() => this.#running.delete(row.account_id))
          this.#running.set(row.account_id, task)
          started.push(task)
        }
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

  async #writeImap(row: MutationRow) {
    const original = row.undo_of ? this.#row(row.undo_of) : undefined
    const journal = readJournal(row)
    const entry: ImapJournalEntry = journal[0] ?? { applied: [], superseded: [], failed: [] }
    journal[0] = entry
    if (original && (!['applied', 'partial'].includes(original.status) || !original.prepared)) {
      this.#finish(row, 'failed', 'The original IMAP action has no verified changes to undo')
      return
    }
    if (original) {
      const error =
        this.#undoStateError(original, row.id) ??
        (this.#hasVerifiedImapUndo(original) ? undefined : IMAP_UNDO_UNVERIFIED)
      if (error) {
        this.#finish(row, 'failed', error)
        return
      }
    }
    const changes: ImapChange[] = original
      ? this.#undoChanges(original)
      : this.#patches(row.id).map(fromPatch)
    if (original) {
      const sources = new Map(
        readJournal(original).flatMap(({ applied }) =>
          (applied as ImapChange[]).map(
            ({ message_id, moveFrom }) => [message_id, moveFrom] as const,
          ),
        ),
      )
      for (const change of changes) change.moveFrom = sources.get(change.message_id)
    }
    const restricted = this.#db
      .prepare(`
      SELECT 1 FROM token WHERE id = ? AND (
        kind = 'agent' OR 'admin' NOT IN (SELECT value FROM json_each(token.scopes))
      )
    `)
      .get(row.principal)
    const allowTrash = !row.agent_action_id && !original?.agent_action_id && !restricted
    const beforeWrite = () => {
      if (row.agent_action_id && !this.#agentGrantActive(row))
        throw new MutationPermissionError(GRANT_EXPIRED)
    }
    try {
      if (changes.length || entry.pending) {
        const ran = await this.#imap?.(row.account_id, (sync) =>
          executeImap(
            sync,
            changes,
            entry,
            () => this.#saveJournal(row, journal),
            allowTrash,
            beforeWrite,
          ),
        )
        if (!ran) return
      }
    } catch (error) {
      if (error instanceof MutationPermissionError) {
        this.#stopAgentWrite(row, journal, entry.pending?.copied ? IMAP_COPY_INCOMPLETE : undefined)
        return
      }
      if (!entry.pending?.copied && this.#retry(row, error)) return
      if (!entry.pending?.copied) {
        entry.error ??= 'Could not verify the change with the IMAP server'
        if (entry.pending) {
          entry.uncertain ??= []
          entry.uncertain.push(entry.pending.change)
        }
        const done = new Set(messageResults(journal).map(({ messageId }) => messageId))
        entry.failed.push(...changes.filter(({ message_id }) => !done.has(message_id)))
      }
    }
    if (entry.pending?.copied) {
      const { change } = entry.pending
      transaction(this.#db, () => {
        this.#db
          .prepare('UPDATE mutation SET error = ? WHERE id = ?')
          .run(IMAP_COPY_INCOMPLETE, row.id)
        this.#db
          .prepare(
            "UPDATE mutation_message SET patch = '{}' WHERE mutation_id = ? AND message_id = ?",
          )
          .run(row.id, change.message_id)
        this.#store.refreshMessageLabels(change.message_id)
        this.#refreshThread(row.thread_id, row.id)
      })
      // Try once on the next pass, then use the existing bounded backoff.
      if (row.error !== IMAP_COPY_INCOMPLETE || this.#retry(row, new Error(IMAP_COPY_INCOMPLETE)))
        return
      entry.error = IMAP_COPY_INCOMPLETE
      entry.failed.push(change)
      const done = new Set(messageResults(journal).map(({ messageId }) => messageId))
      entry.failed.push(
        ...changes.filter(
          ({ message_id, after }) => !done.has(message_id) && Object.keys(after).length,
        ),
      )
    }
    transaction(this.#db, () => {
      this.#db.prepare('UPDATE mutation SET prepared = 1 WHERE id = ?').run(row.id)
      if (original) {
        row.state_patch = JSON.stringify(
          this.#undoState(original, this.#committedState(row.thread_id)),
        )
        this.#db
          .prepare('UPDATE mutation SET state_patch = ? WHERE id = ?')
          .run(row.state_patch, row.id)
      }
      this.#finish(
        row,
        entry.error ? (entry.applied.length ? 'partial' : 'failed') : 'applied',
        entry.error ?? null,
        journal,
      )
    })
  }

  #stopAgentWrite(row: MutationRow, journal: JournalEntry[], detail = row.error) {
    for (const entry of journal) {
      if (!entry.pending) continue
      entry.uncertain = [...(entry.uncertain ?? []), entry.pending.change]
      delete entry.pending
    }
    this.#failRemaining(row, journal, this.#writePlan(row).steps)
    this.#finishWrite(row, journal, detail ? `${detail}. ${GRANT_EXPIRED}` : GRANT_EXPIRED)
  }

  #agentGrantActive(row: MutationRow): boolean {
    return agentGrantActive(this.#db, row.principal, 'organize', this.#now(), row.account_id)
  }

  #snoozedLabel(account: string): string | undefined {
    const stored = this.#db
      .prepare('SELECT provider_id FROM label WHERE account_id = ? AND name = ?')
      .get(account, SNOOZED_LABEL) as { provider_id: string } | undefined
    return stored?.provider_id
  }

  #revisions(labels: Record<string, boolean | null>, historyId: string | undefined) {
    return historyId ? Object.fromEntries(Object.keys(labels).map((key) => [key, historyId])) : {}
  }

  async #readHistory(api: GmailApi, start: string): Promise<HistorySnapshot | null> {
    const records: GmailHistoryRecord[] = []
    let pageToken: string | undefined
    let watermark = start
    do {
      const page = await api.history(start, pageToken, true)
      if (!page) return null
      records.push(...(page.history ?? []))
      pageToken = page.nextPageToken
      watermark = page.historyId
    } while (pageToken)
    return { records, watermark }
  }

  #messageHistory(
    account: string,
    id: string,
    observedHistoryId: string | undefined,
    snoozedId: string | undefined,
    history: HistorySnapshot | null,
  ): MessageHistory | null {
    if (!history) return null
    if (observedHistoryId && !this.#historyIncludes(history.watermark, observedHistoryId))
      throw new Error('Gmail history has not caught up with the message')
    const raw = id.slice(account.length + 1)
    const events: LabelEvent[] = []
    let delivered = false
    let deleted = false
    for (const record of history.records) {
      const delivery = record.messagesAdded?.some(({ message }) => message.id === raw)
      delivered ||= Boolean(delivery)
      deleted ||= Boolean(record.messagesDeleted?.some(({ message }) => message.id === raw))
      for (const [type, present] of [
        ['labelsAdded', true],
        ['labelsRemoved', false],
      ] as const) {
        for (const { message, labelIds } of record[type] ?? []) {
          if (message.id !== raw) continue
          for (const label of labelIds) {
            if (delivery && present && label === 'INBOX') continue
            events.push({
              revision: record.id,
              label: labelId(account, label === snoozedId ? SNOOZED_LABEL : label),
              present,
            })
          }
        }
      }
    }
    return { events, deleted, delivered }
  }

  async #acknowledgedRevisions(
    api: GmailApi,
    account: string,
    change: Change,
    snoozedId: string | undefined,
    start: string | undefined,
    message: GmailMessageState,
  ): Promise<Record<string, string>> {
    if (message.historyId) return this.#revisions(change.after, message.historyId)
    if (!start) return {}

    // Gmail can acknowledge a write without historyId. Use the next message read
    // to bound the search, then retain only unambiguous transitions in that window.
    const id = change.message_id
    try {
      const observed = await api.getMessageState(id.slice(account.length + 1), true)
      const end = observed?.historyId
      if (!end || this.#historyIncludes(start, end)) return {}
      const snapshot = await this.#readHistory(api, start)
      const history = this.#messageHistory(account, id, end, snoozedId, snapshot)
      if (!history || history.deleted) return {}
      const revisions: Record<string, string> = {}
      for (const [label, present] of Object.entries(change.after)) {
        const events = history.events.filter(
          (event) => event.label === label && this.#historyIncludes(end, event.revision),
        )
        const [event] = events
        if (events.length === 1 && event?.present === present) revisions[label] = event.revision
      }
      return revisions
    } catch {
      // The write was acknowledged. If the history read fails, preserve the
      // acknowledgement and leave Undo unverified for these labels.
      return {}
    }
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

  #historyIncludes(cursor: string | null, revision: string | undefined): boolean {
    return Boolean(cursor && revision && BigInt(revision) <= BigInt(cursor))
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

  #intentJournals(intentId: string, excludeId = ''): JournalEntry[] {
    const rows = this.#db
      .prepare('SELECT * FROM mutation WHERE id != ? AND (id = ? OR intent_id = ?)')
      .all(excludeId, intentId, intentId) as unknown as MutationRow[]
    return rows.flatMap(readJournal)
  }

  #markerMessages(account: string, intent: Intent, journal: JournalEntry[]): Set<string> {
    const marker = labelId(account, SNOOZED_LABEL)
    const messages = new Set<string>()
    for (const { applied } of journal) {
      for (const change of applied) {
        const revision = change.revisions?.[marker]
        // A marker belongs to this intent only if Gmail acknowledged its addition
        // after the checkpoint and the dispatch baseline showed it was absent.
        if (
          change.before[marker] === false &&
          change.after[marker] &&
          revision &&
          !this.#historyIncludes(intent.history_id, revision)
        )
          messages.add(change.message_id)
      }
    }
    return messages
  }

  async #step(
    api: GmailApi,
    row: MutationRow,
    step: Step,
    entry: JournalEntry,
    journal: JournalEntry[],
    replan?: (
      messages: GmailMessage[],
      current: Map<string, ProviderObservation>,
      markers: ReadonlySet<string>,
    ) => Change[],
  ) {
    const account = row.account_id
    const inbox = labelId(account, 'INBOX')
    const trash = labelId(account, 'TRASH')
    const spam = labelId(account, 'SPAM')
    const snoozed = labelId(account, SNOOZED_LABEL)
    const rawId = (id: string) => id.slice(account.length + 1)
    const intent = row.intent_id ? this.#intent(row.intent_id) : undefined
    const automatic = intent ? (JSON.parse(row.request) as AutomaticRequest) : undefined
    const sourceJournals = intent ? this.#intentJournals(intent.id, row.id) : []
    const markers = intent
      ? this.#markerMessages(account, intent, sourceJournals)
      : new Set<string>()
    const save = () => this.#saveJournal(row, journal)
    const snoozedId = this.#snoozedLabel(account)
    const startsSnooze = JSON.parse(row.request).kind === 'snooze' && this.#intent(row.id)
    const mayWriteMarker = this.snoozeEnabled && (automatic?.snooze || startsSnooze)
    // Retire queued cleanup if a replacement took effect, even if it has since been cancelled.
    if (
      intent &&
      automatic?.cancelled &&
      this.#db
        .prepare(
          `SELECT 1 FROM mutation WHERE thread_id = ? AND status = 'applied'
           AND seq > (SELECT seq FROM mutation WHERE id = ?)
           AND json_extract(request, '$.kind') = 'snooze' LIMIT 1`,
        )
        .get(row.thread_id, intent.id)
    )
      return true
    if (journal.some((item) => item.intentSuperseded)) return true
    if (mayWriteMarker && step.patch[snoozed] && !snoozedId && !automatic) {
      entry.error = 'Gmail Snooze label is unavailable. Try again after the Account syncs.'
      entry.failed = step.changes
      save()
      return true
    }

    while (true) {
      const thread = replan || automatic?.snooze ? await this.#gmailThread(api, row) : undefined
      const ids = replan
        ? entry.pending
          ? [entry.pending.change.message_id]
          : []
        : step.changes.map((change) => change.message_id)
      const current = await this.#observe(api, row, ids, thread)
      const pages = new Map<string, Promise<HistorySnapshot | null>>()
      const snapshot = (start: string) => {
        let request = pages.get(start)
        if (!request) {
          request = this.#readHistory(api, start)
          pages.set(start, request)
        }
        return request
      }
      const history = async (id: string, start: string, force = false) => {
        const observedHistoryId = current.get(id)?.historyId
        if (!force && start === observedHistoryId)
          return { events: [], deleted: false, delivered: false }
        return this.#messageHistory(
          account,
          id,
          observedHistoryId,
          snoozedId,
          await snapshot(start),
        )
      }

      const pending = entry.pending
      if (pending) {
        const { change, historyId } = pending
        const messageHistory = historyId ? await history(change.message_id, historyId) : null
        const uncertain: LabelPatch = {}
        const superseded: LabelPatch = {}
        for (const [key, value] of Object.entries(change.after)) {
          const events = messageHistory?.events.filter(({ label }) => key === label) ?? []
          // Gmail history has no actor. A matching transition settles the retry,
          // but only an acknowledged write can supply an Undo revision.
          const matchesDispatch = events[0]?.present === value
          if (replan && key === inbox && value && (matchesDispatch || !messageHistory))
            entry.wakeConsumed = true
          if (!messageHistory || messageHistory.deleted || events.length) {
            if (
              !messageHistory ||
              step.trash !== undefined ||
              (matchesDispatch && events.length === 1)
            )
              uncertain[key] = value
            else superseded[key] = value
          }
        }
        if (Object.keys(uncertain).length || Object.keys(superseded).length) {
          if (Object.keys(uncertain).length)
            entry.uncertain = combine([...(entry.uncertain ?? []), { ...change, after: uncertain }])
          if (Object.keys(superseded).length)
            entry.superseded = combine([...entry.superseded, { ...change, after: superseded }])
          delete entry.pending
          save()
        }
      }
      const acknowledged = acknowledgedLabels([...sourceJournals, ...journal])
      const ownerChanged = (id: string, event: Pick<LabelEvent, 'label' | 'revision'>) =>
        !acknowledged.has(JSON.stringify([id, event.label, event.revision]))
      if (intent && automatic?.snooze) {
        // Check every message before each automatic write. A marker edit on a
        // sibling cancels the whole Snooze, including wake and marker cleanup.
        const markerHistory = await snapshot(intent.history_id)
        const threadId = rawId(row.thread_id)
        if (
          markerHistory &&
          [...current.values()].some(
            ({ historyId }) =>
              historyId && !this.#historyIncludes(markerHistory.watermark, historyId),
          )
        )
          throw new Error('Gmail history has not caught up with the Snoozed thread')
        const conflicted =
          !markerHistory ||
          !snoozedId ||
          snoozedId !== intent.marker_id ||
          markerHistory.records.some((record) =>
            [...(record.labelsAdded ?? []), ...(record.labelsRemoved ?? [])].some(
              ({ message, labelIds }) =>
                message.threadId === threadId &&
                labelIds.includes(snoozedId) &&
                ownerChanged(messageId(account, message.id), {
                  label: snoozed,
                  revision: record.id,
                }),
            ),
          )
        if (conflicted) {
          entry.intentSuperseded = true
          entry.superseded = combine([...entry.superseded, ...step.changes])
          delete entry.pending
          save()
          return true
        }
      }
      const changes = replan && thread ? replan(thread, current, markers) : step.changes
      const touched = async (change: Change, key: string, start = change.revisions?.[key]) => {
        if (!start) return true
        const { message_id } = change
        const oldest = Object.values(change.revisions ?? {}).reduce(
          (min, revision) => (this.#historyIncludes(min, revision) ? revision : min),
          start,
        )
        const changes = await history(message_id, oldest)
        return (
          !changes ||
          changes.deleted ||
          changes.events.some(
            ({ label, revision }) =>
              label === key &&
              !this.#historyIncludes(start, revision) &&
              !acknowledged.has(JSON.stringify([message_id, label, revision])),
          )
        )
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
        if (intent && automatic && Object.keys(change.after).length) {
          this.#trackIntentMessage(intent.id, message_id, automatic.work)
          let found = await history(message_id, intent.history_id, true)
          if (!found && !automatic.snooze) {
            // An older Mute can still cover a delivery witnessed by sync. This
            // message had no labels before that delivery, so it has no missing
            // label history between the original intent and the delivery.
            const delivery = this.#db
              .prepare('SELECT provider_delivery_history_id AS revision FROM message WHERE id = ?')
              .get(message_id) as { revision: string | null } | undefined
            if (
              delivery?.revision &&
              !this.#historyIncludes(intent.history_id, delivery.revision)
            ) {
              const sinceDelivery = await history(message_id, delivery.revision, true)
              if (sinceDelivery) found = { ...sinceDelivery, delivered: true }
            }
          }
          const inboxEdited =
            !found ||
            found.deleted ||
            found.events.some((event) => event.label === inbox && ownerChanged(message_id, event))
          if (
            automatic.work === 'suppress' &&
            (!found?.delivered ||
              inboxEdited ||
              labels?.includes(trash) ||
              labels?.includes(spam) ||
              found.events.some(
                (event) =>
                  (event.label === trash || event.label === spam) &&
                  ownerChanged(message_id, event),
              ))
          ) {
            entry.superseded = combine([...entry.superseded, change])
            continue
          }
          if (automatic.work === 'wake' && inboxEdited && inbox in change.after) {
            superseded[inbox] = true
            entry.wakeConsumed = true
          }
        }
        for (const [key, value] of Object.entries(change.after)) {
          if (key in done || key in superseded || (key === snoozed && !snoozedId)) continue
          // Older prepared user actions can still contain marker steps. Keep their
          // progress and acknowledgement indexes, but do not dispatch those writes.
          if (!mayWriteMarker && (key === snoozed || rawId(key) === snoozedId)) continue
          const revision = change.revisions?.[key]
          if (
            !labels ||
            (await touched(change, key)) ||
            (key === trash && (await touched(change, inbox, revision))) ||
            (replan &&
              row.principal === INTERNAL &&
              key === inbox &&
              value &&
              (await touched(change, snoozed))) ||
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

      const beforeDispatch = row.agent_action_id
        ? () => {
            if (!this.#agentGrantActive(row)) throw new MutationPermissionError(GRANT_EXPIRED)
          }
        : undefined
      beforeDispatch?.()
      const { message_id, after } = candidate
      const historyId = current.get(message_id)?.historyId
      entry.pending = { change: candidate, historyId }
      save()
      const acknowledge = async (message: GmailMessageState) => {
        const revisions = await this.#acknowledgedRevisions(
          api,
          account,
          candidate,
          snoozedId,
          historyId,
          message,
        )
        transaction(this.#db, () => {
          this.#bumpEpoch(account)
          this.#store.putProviderLabels(
            account,
            rawId(message_id),
            message.labelIds ?? [],
            message.historyId,
          )
          entry.applied = combine([...entry.applied, { ...candidate, revisions }])
          delete entry.pending
          save()
        })
      }
      try {
        if (step.trash !== undefined) {
          await acknowledge(await api.setTrashed(rawId(message_id), step.trash))
        } else {
          const add: string[] = []
          const remove: string[] = []
          for (const [key, present] of Object.entries(after)) {
            const label = key === snoozed ? snoozedId : rawId(key)
            if (label) (present ? add : remove).push(label)
          }
          await acknowledge(
            beforeDispatch
              ? await api.modifyMessage(rawId(message_id), add, remove, beforeDispatch)
              : await api.modifyMessage(rawId(message_id), add, remove),
          )
        }
      } catch (error) {
        if (error instanceof MutationPermissionError) {
          // The request never started. Clear the journal marker before stopping the grant.
          delete entry.pending
          throw error
        }
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
    markers: ReadonlySet<string>,
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
    const changes: Change[] = []
    let wake: string | undefined
    const { replied, cancelled } = JSON.parse(row.request) as AutomaticRequest
    if (!archive && !cancelled) {
      const state = this.#committedState(row.thread_id)
      const eligible = (labels: string[]) =>
        !labels.includes(labelId(account, 'TRASH')) && !labels.includes(labelId(account, 'SPAM'))
      // A confirmed wake is complete. An ambiguous response also needs no replay
      // while the target is already in Inbox. A vanished target can be replaced.
      const alreadyWoke =
        entry.wakeConsumed ||
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
      } else {
        if (markers.has(id) && (labels.includes(marker) || original?.before[marker]))
          after[marker] = false
        if (id === wake) after[inbox] = true
      }
      for (const key of Object.keys(applied.get(id)?.after ?? {})) {
        // A prior acknowledged write is complete, even if the owner edited it again.
        delete after[key]
      }
      const before = {
        ...this.#before(
          account,
          archive ? { [inbox]: false } : { [inbox]: false, [marker]: false },
          labels,
        ),
        ...original?.before,
      }
      const change = {
        message_id: id,
        before,
        after,
        revisions: original?.revisions ?? this.#revisions(before, current.get(id)?.historyId),
      }
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
    const dynamic = this.#isSnoozeExit(row) || JSON.parse(row.request).kind === 'archive'
    const steps: Step[] = dynamic ? [{ patch: {}, changes }] : stepsFor(row.account_id, changes)
    if (row.intent_id && !steps.length) steps.push({ patch: {}, changes: [] })
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
    const stateError = original && this.#undoStateError(original, row.id)
    if (stateError) {
      this.#finish(row, 'failed', stateError)
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
            ? (messages, current, markers) =>
                this.#replan(row, messages, current, baseline, entry, markers)
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
      if (error instanceof MutationPermissionError) {
        this.#stopAgentWrite(row, journal)
        return
      }
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
    if (journal.some((entry) => entry.uncertain?.some(({ after }) => trash in after))) {
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

  #finishIntent(
    row: MutationRow,
    intentId: string,
    status: MutationResult['status'],
    journal: JournalEntry[],
  ): boolean {
    const { work, snooze, checkThrough, cancelled } = JSON.parse(row.request) as AutomaticRequest
    const superseded = journal.some((entry) => entry.intentSuperseded)
    const outcomes = new Map(messageResults(journal).map((outcome) => [outcome.messageId, outcome]))
    const settle = this.#db.prepare(
      "UPDATE organise_intent_message SET status = ? WHERE intent_id = ? AND message_id = ? AND work = ? AND status = 'pending'",
    )
    for (const id of this.#intentMessages(intentId, work)) {
      const outcome = outcomes.get(id)
      settle.run(
        superseded || status === 'failed' || outcome?.status === 'superseded'
          ? 'superseded'
          : 'done',
        intentId,
        id,
        work,
      )
    }
    this.#db
      .prepare('UPDATE organise_intent SET checked_history_id = ?, status = ? WHERE id = ?')
      .run(checkThrough, superseded ? 'superseded' : work === 'wake' ? 'done' : 'active', intentId)
    return snooze && superseded && !cancelled
  }

  #queueSnoozeCleanup(thread: ThreadRow, intentId: string) {
    if (!this.snoozeEnabled) return
    const intent = this.#intent(intentId)
    if (intent?.status !== 'active') return
    const request: AutomaticRequest = {
      work: 'wake',
      snooze: true,
      replied: false,
      cancelled: true,
      checkThrough: intent.checked_history_id,
    }
    this.#insert(
      randomUUID(),
      INTERNAL,
      JSON.stringify(request),
      thread,
      {},
      () => ({}),
      null,
      intentId,
    )
  }

  #finish(
    row: MutationRow,
    status: MutationResult['status'],
    error: string | null,
    journal?: JournalEntry[],
    { discard = false } = {},
  ) {
    transaction(this.#db, () => {
      if (journal) {
        for (const entry of journal) delete entry.pending
        this.#saveJournal(row, journal)
      }
      const clearSupersededSnooze =
        !discard && row.intent_id
          ? this.#finishIntent(row, row.intent_id, status, journal ?? [])
          : false
      this.#db
        .prepare('UPDATE mutation SET status = ?, error = ?, next_attempt = ? WHERE id = ?')
        .run(status, error, this.#now() + 60_000, row.id)
      const statePatch = clearSupersededSnooze
        ? CLEAR_SNOOZE
        : (JSON.parse(row.state_patch) as Partial<ThreadState>)
      const userAction = row.principal !== INTERNAL
      const succeeded = status === 'applied' || status === 'partial'
      const { kind } = JSON.parse(row.request)
      const cancelsSnooze =
        userAction &&
        succeeded &&
        kind !== 'snooze' &&
        (kind !== 'undo' || statePatch.snoozeIntent === null)
      const patch =
        !discard && (status === 'applied' || (!userAction && statePatch.snoozedUntil === null))
          ? { ...statePatch }
          : {}
      if (cancelsSnooze) Object.assign(patch, CLEAR_SNOOZE)
      if (Object.keys(patch).length) {
        const thread = this.#db
          .prepare('SELECT id, account_id, organise_state FROM thread WHERE id = ?')
          .get(row.thread_id) as ThreadRow | undefined
        if (thread) {
          const state = this.#committedState(row.thread_id)
          this.#db
            .prepare('UPDATE thread SET organise_state = ? WHERE id = ?')
            .run(JSON.stringify({ ...state, ...patch }), row.thread_id)
          if (userAction && state.snoozeIntent) {
            if (cancelsSnooze) this.#queueSnoozeCleanup(thread, state.snoozeIntent)
            else if (patch.snoozeIntent && patch.snoozeIntent !== state.snoozeIntent)
              this.#db
                .prepare("UPDATE organise_intent SET status = 'done' WHERE id = ?")
                .run(state.snoozeIntent)
          }
        }
      }
      for (const patch of this.#patches(row.id)) this.#store.refreshMessageLabels(patch.message_id)
      this.#refreshThread(row.thread_id, row.id)
    })
  }
}
