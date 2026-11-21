import type { Logger } from '../../log.ts'
import { type MailStore, messageId } from '../../mail/store.ts'
import { fromGmail } from './mapping.ts'
import type { GmailApi, GmailLabel, GmailMessageRef } from './types.ts'

export interface GmailCursor {
  historyId?: string
}

export interface BackfillState {
  /** `recent` = Inbox and the last 90 days first; then `all`; then `done`. */
  phase?: 'recent' | 'all' | 'done'
  pageToken?: string | null
  fetched?: number
  estimatedTotal?: number
  /** After a resync: delete local messages Gmail no longer has, once `all` completes. */
  reconcile?: boolean
}

/** Persistence the sync needs for one Account (the account table, in the Engine). */
export interface AccountState {
  readonly accountId: string
  readonly ownAddresses: readonly string[]
  cursor(): GmailCursor
  saveCursor(cursor: GmailCursor): void
  backfill(): BackfillState
  saveBackfill(state: BackfillState): void
}

const RECENT_QUERY = '{in:inbox newer_than:90d}'
const FETCH_CONCURRENCY = 6
const STORE_CHUNK = 50

async function mapLimit<T, R>(
  items: T[],
  limit: number,
  fn: (item: T) => Promise<R>,
): Promise<R[]> {
  const results: R[] = new Array(items.length)
  let next = 0
  const workers = Array.from({ length: Math.min(limit, items.length) }, async () => {
    while (next < items.length) {
      const index = next++
      results[index] = await fn(items[index] as T)
    }
  })
  await Promise.all(workers)
  return results
}

export function toIncomingLabel(label: GmailLabel) {
  return {
    providerId: label.id,
    name: label.name,
    kind: label.type,
    color: label.color?.backgroundColor ?? null,
  }
}

/**
 * Keeps one Gmail Account in step with the store (plan §4.3).
 * - `incremental()` applies `history.list` since the saved historyId; on a too-old historyId it
 *   starts over from the current one and schedules a reconciling full pass.
 * - `backfillStep()` fetches one page of message ids (newest first) and stores the missing ones.
 * Both are safe to interleave; the store is the single writer.
 */
export class GmailAccountSync {
  readonly #api: GmailApi
  readonly #store: MailStore
  readonly #state: AccountState
  readonly #log: Logger
  readonly #seen = new Set<string>()
  /** Called after each stored chunk (the manager uses it to tell live Clients). */
  onProgress?: (stored: number) => void
  #reconcileTrusted = false
  #scanGeneration = 0
  #backfillChanges: Set<string> | undefined

  constructor(api: GmailApi, store: MailStore, state: AccountState, log: Logger) {
    this.#api = api
    this.#store = store
    this.#state = state
    this.#log = log
  }

  /** First run: remember where history starts, before backfilling, so nothing is missed. */
  async start(): Promise<void> {
    await this.syncLabels()
    if (!this.#state.cursor().historyId) {
      const profile = await this.#api.profile()
      this.#state.saveCursor({ historyId: profile.historyId })
      this.#state.saveBackfill({
        phase: 'recent',
        pageToken: null,
        fetched: 0,
        estimatedTotal: profile.messagesTotal,
      })
    }
  }

  async syncLabels(): Promise<void> {
    const labels = await this.#api.labels()
    this.#store.syncLabels(this.#state.accountId, labels.map(toIncomingLabel))
  }

  get backfillDone(): boolean {
    return this.#state.backfill().phase === 'done'
  }

  /** Applies everything that changed since the last run. Returns the number of changes applied. */
  async incremental(): Promise<number> {
    const startId = this.#state.cursor().historyId
    if (!startId) return 0
    const account = this.#state.accountId
    const epoch = this.#store.writeEpoch(account)

    const added = new Map<string, GmailMessageRef>()
    const labelUpdates = new Set<string>()
    const inboxRestored = new Set<string>()
    const deleted = new Set<string>()
    let pageToken: string | undefined
    let latest = startId

    do {
      const page = await this.#api.history(startId, pageToken)
      if (!page) {
        await this.#resync()
        return 0
      }
      for (const record of page.history ?? []) {
        for (const { message } of record.messagesAdded ?? []) {
          added.set(message.id, message)
          deleted.delete(message.id)
        }
        for (const { message } of record.messagesDeleted ?? []) {
          deleted.add(message.id)
          added.delete(message.id)
          labelUpdates.delete(message.id)
        }
        const delivered = new Set(record.messagesAdded?.map(({ message }) => message.id))
        for (const { message, labelIds } of record.labelsAdded ?? []) {
          if (labelIds.includes('INBOX') && !delivered.has(message.id))
            inboxRestored.add(message.id)
        }
        for (const change of [...(record.labelsAdded ?? []), ...(record.labelsRemoved ?? [])]) {
          if (!deleted.has(change.message.id)) labelUpdates.add(change.message.id)
        }
      }
      latest = page.historyId
      pageToken = page.nextPageToken
    } while (pageToken)

    // History identifies changed messages. Fetch current labels: history can contain an older
    // echo, and Gmail does not guarantee message.labelIds is present in history entries.
    const known = [...labelUpdates].filter((id) => {
      if (added.has(id)) return false
      if (this.#store.hasMessage(account, id)) return true
      added.set(id, { id, threadId: '' })
      return false
    })
    const current = await mapLimit(known, FETCH_CONCURRENCY, (id) => this.#api.getMessageState(id))
    if (this.#store.writeEpoch(account) !== epoch) return 0
    let changes = 0
    for (const id of deleted) {
      this.#backfillChanges?.add(id)
      this.#store.deleteMessage(this.#state.accountId, id)
      changes++
    }
    for (const [index, id] of known.entries()) {
      this.#backfillChanges?.add(id)
      const message = current[index]
      if (inboxRestored.has(id)) this.#store.markMuteSuppressionHandled(messageId(account, id))
      if (message)
        this.#store.setMessageLabels(account, id, message.labelIds ?? [], message.historyId)
      else this.#store.deleteMessage(account, id)
      changes++
    }
    changes += await this.#fetchAndStore([...added.keys()], true, undefined, inboxRestored)

    if (this.#store.writeEpoch(account) !== epoch) return changes
    this.#state.saveCursor({ historyId: latest })
    if (changes > 0)
      this.#log.info({ account: this.#state.accountId, changes }, 'gmail changes applied')
    return changes
  }

  /** One page of backfill. Returns false when there is nothing left to do. */
  async backfillStep(): Promise<boolean> {
    const changed = new Set<string>()
    this.#backfillChanges = changed
    try {
      return await this.#scanPage(this.#scanGeneration, changed)
    } finally {
      this.#backfillChanges = undefined
    }
  }

  async #scanPage(generation: number, changed: Set<string>): Promise<boolean> {
    const state = this.#state.backfill()
    if (!state.phase || state.phase === 'done') return false

    const page = await this.#api.listMessages({
      pageToken: state.pageToken ?? undefined,
      q: state.phase === 'recent' ? RECENT_QUERY : undefined,
      maxResults: 500,
    })
    if (generation !== this.#scanGeneration) return true
    const ids = (page.messages ?? []).map((m) => m.id)
    const missing = ids.filter((id) => !this.#store.hasMessage(this.#state.accountId, id))
    if (state.reconcile) {
      const account = this.#state.accountId
      const epoch = this.#store.writeEpoch(account)
      const missingSet = new Set(missing)
      const known = ids.filter((id) => !missingSet.has(id))
      const labels = await mapLimit(known, FETCH_CONCURRENCY, (id) => this.#api.getMessageState(id))
      if (this.#store.writeEpoch(account) !== epoch || generation !== this.#scanGeneration)
        return true
      for (const [index, id] of known.entries()) {
        const current = labels[index]
        if (current && !changed.has(id))
          this.#store.setMessageLabels(account, id, current.labelIds ?? [], current.historyId)
      }
    }
    const stored = await this.#fetchAndStore(missing, false, { generation, changed })
    if (generation !== this.#scanGeneration) return true
    if (state.phase === 'all') for (const id of ids) this.#seen.add(id)

    const next: BackfillState = { ...state, fetched: (state.fetched ?? 0) + stored }
    if (page.nextPageToken) {
      next.pageToken = page.nextPageToken
    } else if (state.phase === 'recent') {
      next.phase = 'all'
      next.pageToken = null
      this.#reconcileTrusted = true
      this.#seen.clear()
    } else {
      if (!(await this.#finishAllPhase(state, generation, changed))) return true
      if (generation !== this.#scanGeneration) return true
      next.phase = 'done'
      next.pageToken = null
      next.reconcile = false
    }
    this.#state.saveBackfill(next)
    return next.phase !== 'done'
  }

  /** Fetches in small chunks and stores each one, so an error never discards finished work. */
  async #fetchAndStore(
    ids: string[],
    perMessage: boolean,
    scan?: { generation: number; changed: Set<string> },
    inboxRestored?: Set<string>,
  ): Promise<number> {
    let stored = 0
    for (let i = 0; i < ids.length; i += STORE_CHUNK) {
      const epoch = this.#store.writeEpoch(this.#state.accountId)
      const chunk = ids.slice(i, i + STORE_CHUNK)
      const messages = await mapLimit(chunk, FETCH_CONCURRENCY, (id) =>
        this.#api.getMessage(id, perMessage),
      )
      if (epoch !== this.#store.writeEpoch(this.#state.accountId)) {
        i -= STORE_CHUNK
        continue
      }
      if (scan && scan.generation !== this.#scanGeneration) return stored
      const incoming = messages
        .filter((m) => m !== null)
        .filter((m) => !scan?.changed.has(m.id))
        .map((message) => ({
          ...fromGmail(message),
          inboxRestored: inboxRestored?.has(message.id),
        }))
      if (perMessage) {
        for (const msg of incoming) {
          this.#backfillChanges?.add(msg.providerId)
          this.#store.putMessage(this.#state.accountId, this.#state.ownAddresses, msg)
        }
      } else {
        this.#store.putMessages(this.#state.accountId, this.#state.ownAddresses, incoming)
      }
      stored += incoming.length
      this.onProgress?.(incoming.length)
    }
    return stored
  }

  /** History is gone (Gmail keeps about a week): start from now and rescan everything. */
  async #resync(): Promise<void> {
    const profile = await this.#api.profile()
    this.#log.warn({ account: this.#state.accountId }, 'gmail history expired; resyncing')
    this.#state.saveCursor({ historyId: profile.historyId })
    this.#state.saveBackfill({
      phase: 'all',
      pageToken: null,
      fetched: this.#state.backfill().fetched ?? 0,
      estimatedTotal: profile.messagesTotal,
      reconcile: true,
    })
    this.#scanGeneration++
    this.#seen.clear()
    this.#reconcileTrusted = true
  }

  /**
   * Reconciles messages that Gmail omitted from listing after a complete in-process scan.
   * A restart mid-pass leaves the seen-set incomplete.
   */
  async #finishAllPhase(
    state: BackfillState,
    generation: number,
    changed: Set<string>,
  ): Promise<boolean> {
    if (!state.reconcile || !this.#reconcileTrusted) return true
    const local = this.#store.db
      .prepare('SELECT provider_id FROM message WHERE account_id = ?')
      .all(this.#state.accountId) as { provider_id: string }[]
    // List pagination can miss messages when the mailbox changes during the scan.
    // Verify both existence and labels. The replacement cursor may already cover these edits.
    const epoch = this.#store.writeEpoch(this.#state.accountId)
    const missing = local.map((row) => row.provider_id).filter((id) => !this.#seen.has(id))
    const current = await mapLimit(missing, FETCH_CONCURRENCY, (id) =>
      this.#api.getMessageState(id),
    )
    if (
      generation !== this.#scanGeneration ||
      epoch !== this.#store.writeEpoch(this.#state.accountId)
    )
      return false
    let removed = 0
    for (const [index, id] of missing.entries()) {
      // Incremental history already applied a more recent read for these messages.
      if (changed.has(id)) continue
      const message = current[index]
      if (message)
        this.#store.setMessageLabels(
          this.#state.accountId,
          id,
          message.labelIds ?? [],
          message.historyId,
        )
      else if (message === null) {
        this.#store.deleteMessage(this.#state.accountId, id)
        removed++
      }
    }
    this.#log.info({ account: this.#state.accountId, removed }, 'reconciled after resync')
    this.#seen.clear()
    return true
  }
}
