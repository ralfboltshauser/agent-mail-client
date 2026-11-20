import type { Logger } from '../../log.ts'
import type { MailStore } from '../../mail/store.ts'
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

    const added = new Map<string, GmailMessageRef>()
    const labelUpdates = new Map<string, string[]>()
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
        for (const change of [...(record.labelsAdded ?? []), ...(record.labelsRemoved ?? [])]) {
          if (change.message.labelIds) labelUpdates.set(change.message.id, change.message.labelIds)
        }
      }
      latest = page.historyId
      pageToken = page.nextPageToken
    } while (pageToken)

    let changes = 0
    for (const id of deleted) {
      this.#store.deleteMessage(this.#state.accountId, id)
      changes++
    }
    // Label changes on messages we hold apply directly; unknown ones get fetched in full.
    for (const [id, labels] of labelUpdates) {
      if (added.has(id)) continue
      if (this.#store.setMessageLabels(this.#state.accountId, id, labels)) changes++
      else added.set(id, { id, threadId: '' })
    }
    changes += await this.#fetchAndStore([...added.keys()], true)

    this.#state.saveCursor({ historyId: latest })
    if (changes > 0)
      this.#log.info({ account: this.#state.accountId, changes }, 'gmail changes applied')
    return changes
  }

  /** One page of backfill. Returns false when there is nothing left to do. */
  async backfillStep(): Promise<boolean> {
    const state = this.#state.backfill()
    if (!state.phase || state.phase === 'done') return false

    const page = await this.#api.listMessages({
      pageToken: state.pageToken ?? undefined,
      q: state.phase === 'recent' ? RECENT_QUERY : undefined,
      maxResults: 500,
    })
    const ids = (page.messages ?? []).map((m) => m.id)
    if (state.phase === 'all') for (const id of ids) this.#seen.add(id)
    const missing = ids.filter((id) => !this.#store.hasMessage(this.#state.accountId, id))
    const stored = await this.#fetchAndStore(missing, false)

    const next: BackfillState = { ...state, fetched: (state.fetched ?? 0) + stored }
    if (page.nextPageToken) {
      next.pageToken = page.nextPageToken
    } else if (state.phase === 'recent') {
      next.phase = 'all'
      next.pageToken = null
      this.#reconcileTrusted = true
      this.#seen.clear()
    } else {
      this.#finishAllPhase(state)
      next.phase = 'done'
      next.pageToken = null
      next.reconcile = false
    }
    this.#state.saveBackfill(next)
    return next.phase !== 'done'
  }

  /** Fetches in small chunks and stores each one, so an error never discards finished work. */
  async #fetchAndStore(ids: string[], perMessage: boolean): Promise<number> {
    let stored = 0
    for (let i = 0; i < ids.length; i += STORE_CHUNK) {
      const chunk = ids.slice(i, i + STORE_CHUNK)
      const messages = await mapLimit(chunk, FETCH_CONCURRENCY, (id) => this.#api.getMessage(id))
      const incoming = messages.filter((m) => m !== null).map(fromGmail)
      if (perMessage) {
        for (const msg of incoming)
          this.#store.putMessage(this.#state.accountId, this.#state.ownAddresses, msg)
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
    this.#seen.clear()
    this.#reconcileTrusted = true
  }

  /**
   * Deletes local messages that Gmail no longer lists, but only when this process saw the whole
   * `all` pass itself (after a restart mid-pass, the seen-set is incomplete and nothing is deleted).
   */
  #finishAllPhase(state: BackfillState): void {
    if (!state.reconcile || !this.#reconcileTrusted) return
    const local = this.#store.db
      .prepare('SELECT provider_id FROM message WHERE account_id = ?')
      .all(this.#state.accountId) as { provider_id: string }[]
    let removed = 0
    for (const { provider_id } of local) {
      if (!this.#seen.has(provider_id)) {
        this.#store.deleteMessage(this.#state.accountId, provider_id)
        removed++
      }
    }
    this.#log.info({ account: this.#state.accountId, removed }, 'reconciled after resync')
    this.#seen.clear()
  }
}
