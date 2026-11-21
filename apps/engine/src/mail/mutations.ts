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

interface Step {
  ids: string[]
  patch: LabelPatch
  trash?: boolean
}

function result(row: MutationRow): MutationResult {
  return {
    id: row.id,
    threadId: row.thread_id,
    status: row.status,
    error: row.error,
    modseq: row.modseq,
  }
}

function stepsFor(accountId: string, patches: PatchRow[]): Step[] {
  const trash = labelId(accountId, 'TRASH')
  const groups = new Map<string, Step>()
  const steps: Step[] = []
  for (const row of patches) {
    const patch = JSON.parse(row.patch) as LabelPatch
    if (trash in patch) {
      const previous = JSON.parse(row.before) as LabelPatch
      if (patch[trash] !== previous[trash]) {
        steps.push({
          ids: [row.message_id],
          patch: { [trash]: Boolean(patch[trash]) },
          trash: patch[trash],
        })
      }
      delete patch[trash]
    }
    if (Object.keys(patch).length === 0) continue
    const key = JSON.stringify(Object.entries(patch).sort())
    let group = groups.get(key)
    if (!group) {
      group = { ids: [], patch }
      groups.set(key, group)
    }
    group.ids.push(row.message_id)
  }
  for (const group of groups.values()) {
    for (let start = 0; start < group.ids.length; start += 1000) {
      steps.push({ ids: group.ids.slice(start, start + 1000), patch: group.patch })
    }
  }
  return steps
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
      const inverses = this.#undoPatches(target, state)
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

  #undoPatches(original: MutationRow, state: Partial<ThreadState>): Map<string, LabelPatch> {
    const snoozed = labelId(original.account_id, SNOOZED_LABEL)
    const inbox = labelId(original.account_id, 'INBOX')
    const trash = labelId(original.account_id, 'TRASH')
    return new Map(
      this.#patches(original.id).map((row) => {
        const inverse = JSON.parse(row.before) as LabelPatch
        if (inverse[snoozed] && !state.snoozedUntil) delete inverse[snoozed]
        const applied = JSON.parse(row.patch) as LabelPatch
        // Trash cannot remove Inbox from a message that was already archived.
        if (applied[trash] && !inverse[inbox]) delete inverse[inbox]
        return [row.message_id, inverse]
      }),
    )
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
    const snoozed = labelId(account, SNOOZED_LABEL)
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
      if (original) {
        statePatch = this.#undoState(original)
        const inverses = this.#undoPatches(original, statePatch)
        patchFor = (id, labels) => {
          const patch = inverses.get(id) ?? {}
          if (statePatch.snoozedUntil === null && labels.includes(snoozed)) patch[snoozed] = false
          if (patch[trash] === false && labels.includes(trash) && !(inbox in patch))
            patch[inbox] = false
          if (
            patch[inbox] &&
            patch[trash] !== false &&
            (labels.includes(trash) || labels.includes(labelId(account, 'SPAM')))
          )
            delete patch[inbox]
          return patch
        }
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
      const projected = this.#patches(row.id)
      this.#db.prepare('DELETE FROM mutation_message WHERE mutation_id = ?').run(row.id)
      const insert = this.#db.prepare('INSERT INTO mutation_message VALUES (?, ?, ?, ?)')
      this.#bumpEpoch(account)
      for (const message of messages) {
        const raw = message.labelIds ?? []
        if (raw.includes('DRAFT')) continue
        const id = messageId(account, message.id)
        const labels = this.#store.providerLabels(account, raw)
        const requested = patchFor(id, labels)
        const changesTrash = trash in requested && requested[trash] !== labels.includes(trash)
        const patch = Object.fromEntries(
          Object.entries(requested).filter(
            ([key, present]) => present !== labels.includes(key) || (changesTrash && key === inbox),
          ),
        )
        if (Object.keys(patch).length) {
          const before = this.#before(account, patch, labels)
          insert.run(row.id, id, JSON.stringify(patch), JSON.stringify(before))
        }
        this.#store.putProviderLabels(account, message.id, raw)
      }
      for (const patch of projected) this.#store.refreshMessageLabels(patch.message_id)
      row.prepared = 1
      row.state_patch = JSON.stringify(statePatch)
      row.state_before = JSON.stringify(stateBefore)
      this.#db
        .prepare('UPDATE mutation SET prepared = 1, state_patch = ?, state_before = ? WHERE id = ?')
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

  async #step(api: GmailApi, account: string, step: Step, checkpoint: () => void): Promise<void> {
    const prefix = `${account}:`
    const ids = step.ids.map((id) => id.slice(prefix.length))
    if (step.trash !== undefined) {
      const id = ids[0] as string
      const labels = await api.setTrashed(id, step.trash)
      transaction(this.#db, () => {
        this.#bumpEpoch(account)
        this.#store.putProviderLabels(account, id, labels)
        checkpoint()
      })
      return
    }
    const add: string[] = []
    const remove: string[] = []
    for (const [key, present] of Object.entries(step.patch)) {
      const raw = key.slice(prefix.length)
      const label = raw === SNOOZED_LABEL ? await this.#snoozedLabel(api, account, present) : raw
      if (label) (present ? add : remove).push(label)
    }
    if (add.length || remove.length) await api.batchModify(ids, add, remove)
    transaction(this.#db, () => {
      this.#bumpEpoch(account)
      for (const id of step.ids) {
        const row = this.#db
          .prepare('SELECT provider_label_ids FROM message WHERE id = ?')
          .get(id) as { provider_label_ids: string | null } | undefined
        if (!row) continue
        const labels = applyLabelPatch(
          JSON.parse(row.provider_label_ids ?? '[]') as string[],
          step.patch,
        )
        this.#db
          .prepare('UPDATE message SET provider_label_ids = ? WHERE id = ?')
          .run(JSON.stringify(labels), id)
        this.#store.refreshMessageLabels(id)
      }
      checkpoint()
    })
  }

  #bumpEpoch(accountId: string) {
    this.#db.prepare('UPDATE account SET write_epoch = write_epoch + 1 WHERE id = ?').run(accountId)
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
    const patches = this.#patches(row.id)
    const steps = stepsFor(row.account_id, patches)
    if (row.rollback_error) {
      await this.#rollback(api, row, patches, steps)
      return
    }
    let progress = row.progress
    try {
      for (; progress < steps.length; progress++) {
        const step = steps[progress]
        if (!step) break
        await this.#step(api, row.account_id, step, () => {
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
      // The failed call may have committed fully or partially before losing its response.
      this.#db
        .prepare(
          'UPDATE mutation SET rollback_error = ?, attempts = 0, next_attempt = 0 WHERE id = ?',
        )
        .run(message, row.id)
      await this.#rollback(
        api,
        { ...row, progress, rollback_error: message, attempts: 0 },
        patches,
        steps,
      )
      return
    }
    this.#finish(row, 'applied', null)
  }

  #retry(row: MutationRow, error: unknown): boolean {
    const transient =
      !(error instanceof GmailHttpError || error instanceof OAuthError) ||
      (error instanceof OAuthError && !error.needsReauth) ||
      (error instanceof GmailHttpError &&
        (error.status === 408 ||
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

  async #observedLabels(
    api: GmailApi,
    row: MutationRow,
    touched: ReadonlyMap<string, Set<string>>,
  ) {
    const account = row.account_id
    const messages = new Map(
      (await this.#gmailThread(api, row)).map((message) => [message.id, message.labelIds ?? []]),
    )
    const observed = new Map<string, string[]>()
    for (const mid of touched.keys()) {
      const id = mid.slice(account.length + 1)
      // Only an individual lookup can confirm that a missing thread member is gone.
      const labels = messages.get(id) ?? (await api.getMessageLabels(id, true))
      if (labels) observed.set(id, labels)
    }
    return transaction(this.#db, () => {
      this.#bumpEpoch(account)
      return new Map(
        Array.from(observed, ([id, labels]) => {
          this.#store.putProviderLabels(account, id, labels)
          return [messageId(account, id), this.#store.providerLabels(account, labels)]
        }),
      )
    })
  }

  async #rollback(api: GmailApi, row: MutationRow, patches: PatchRow[], steps: Step[]) {
    const inbox = labelId(row.account_id, 'INBOX')
    const trash = labelId(row.account_id, 'TRASH')
    const touched = new Map<string, Set<string>>()
    for (const step of steps.slice(0, row.progress + 1)) {
      for (const id of step.ids) {
        const keys = touched.get(id) ?? new Set<string>()
        for (const key of Object.keys(step.patch)) keys.add(key)
        if (step.trash !== undefined) keys.add(inbox)
        touched.set(id, keys)
      }
    }
    const baseline = patches.flatMap((patch) => {
      const keys = touched.get(patch.message_id)
      if (!keys) return []
      const before = JSON.parse(patch.before) as LabelPatch
      return [
        {
          id: patch.message_id,
          labels: Object.fromEntries(Object.entries(before).filter(([key]) => keys.has(key))),
        },
      ]
    })
    const differences = (current: Map<string, string[]>) =>
      baseline.flatMap(({ id, labels }) => {
        const observed = current.get(id)
        if (!observed) return []
        const changesTrash = trash in labels && labels[trash] !== observed.includes(trash)
        const patch = Object.fromEntries(
          Object.entries(labels).filter(
            ([key, present]) =>
              present !== observed.includes(key) || (changesTrash && key === inbox),
          ),
        )
        return Object.keys(patch).length
          ? [
              {
                message_id: id,
                patch: JSON.stringify(patch),
                before: JSON.stringify(this.#before(row.account_id, patch, observed)),
              },
            ]
          : []
      })
    let message = row.rollback_error ?? 'Gmail writeback failed'
    try {
      let rollback: Step[]
      if (row.rollback_plan === null) {
        rollback = stepsFor(
          row.account_id,
          differences(await this.#observedLabels(api, row, touched)),
        )
        this.#db
          .prepare('UPDATE mutation SET rollback_plan = ?, rollback_progress = 0 WHERE id = ?')
          .run(JSON.stringify(rollback), row.id)
        row.rollback_progress = 0
      } else {
        rollback = JSON.parse(row.rollback_plan) as Step[]
      }
      for (const [index, step] of rollback.entries()) {
        if (index < row.rollback_progress) continue
        await this.#step(api, row.account_id, step, () => {
          this.#db
            .prepare('UPDATE mutation SET rollback_progress = ? WHERE id = ?')
            .run(index + 1, row.id)
        })
      }
      if (rollback.length && differences(await this.#observedLabels(api, row, touched)).length)
        message += `. ${PARTIAL_WARNING}`
    } catch (error) {
      if (this.#retry(row, error)) return
      // A failed compensation may also have committed before its response was lost.
      const current = await this.#observedLabels(api, row, touched).catch(() => null)
      if (!current || differences(current).length) message += `. ${PARTIAL_WARNING}`
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
