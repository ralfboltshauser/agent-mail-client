import { EventEmitter } from 'node:events'
import { type EventFields, newRunId, type RunId } from '@amc/observability'
import {
  doctorWarnings,
  type Health,
  type Me,
  type SyncChanges,
  type SyncEntity,
  type SyncSnapshotPage,
  type SyncState,
} from '@amc/protocol'
import type { SyncStatus } from '../shared/api'
import { type FailureDetails, failureDetails } from '../shared/failure'
import { type EngineClient, EngineError } from './engine'
import { newInboxMessages } from './notifications'
import { failureScope, knownFailure, mainLog, rememberFailure } from './observability'
import type { Replica } from './replica'

type SyncStage = EventFields<'desktop.sync.failed'>['stage']

const SNAPSHOT_ORDER: SyncEntity[] = ['account', 'label', 'draft', 'thread', 'message']
const sleep = (ms: number, signal: AbortSignal) =>
  new Promise<void>((resolve) => {
    const t = setTimeout(resolve, ms)
    signal.addEventListener(
      'abort',
      () => {
        clearTimeout(t)
        resolve()
      },
      { once: true },
    )
  })

/**
 * Keeps the replica in step with the Engine: bootstrap from a snapshot, then pull changes
 * whenever the event stream says something changed (and every minute, in case it says nothing).
 */
export class SyncLoop extends EventEmitter<{
  status: [SyncStatus]
  changed: []
  newMail: [ReturnType<typeof newInboxMessages>]
  arrivals: [Map<string, string>]
}> {
  readonly #engine: EngineClient
  readonly #replica: Replica
  readonly #controller = new AbortController()
  #status: SyncStatus
  #pulling: Promise<void> | null = null
  #pullAgain = false
  #healthRefresh = 0
  #nextMailCheckAt = 0
  #accountFailures = new Map<string, FailureDetails>()
  readonly #failures = new Map<SyncStage, FailureDetails>()

  #failed(stage: SyncStage, err: unknown, runId: RunId): FailureDetails {
    const previous = this.#failures.get(stage)
    if (previous) return previous
    const details = failureDetails(err, runId, 'Run')
    const request = knownFailure(err)
    mainLog.log(
      'error',
      'desktop.sync.failed',
      { stage, err },
      {
        ...(request && failureScope(request)),
        runId,
      },
    )
    this.#failures.set(stage, details)
    return details
  }

  #recovered(stage: SyncStage) {
    const failure = this.#failures.get(stage)
    if (!failure) return
    mainLog.log('info', 'desktop.sync.recovered', { stage }, failureScope(failure))
    this.#failures.delete(stage)
  }

  constructor(engine: EngineClient, replica: Replica) {
    super()
    this.#engine = engine
    this.#replica = replica
    this.#status = {
      phase: 'connecting',
      engineUrl: engine.baseUrl,
      progress: null,
      lastSyncAt: null,
      error: null,
    }
  }

  get status(): SyncStatus {
    return this.#status
  }

  #set(patch: Partial<SyncStatus>) {
    this.#status = { ...this.#status, ...patch }
    this.emit('status', this.#status)
  }

  start(): void {
    void this.#run().catch((err: unknown) => {
      if (this.#controller.signal.aborted) return
      const failure = this.#failed('connect', err, newRunId())
      this.#set({ phase: 'error', error: 'Sync stopped', failure })
    })
  }

  stop(): void {
    this.#controller.abort()
  }

  async checkMail(): Promise<void> {
    const signal = this.#controller.signal
    const startedAt = Date.now()
    if (signal.aborted || startedAt < this.#nextMailCheckAt) return
    this.#nextMailCheckAt = Infinity
    const runId = newRunId()
    mainLog.log('debug', 'desktop.sync.started', { stage: 'check-mail' }, { runId })
    this.#set({
      mailCheck: 'checking',
      mailCheckStartedAt: startedAt,
      mailCheckFailure: undefined,
    })
    try {
      const { ok } = await this.#engine.request<{ ok: boolean }>('/v1/sync/check-mail', {
        method: 'POST',
        signal: AbortSignal.any([signal, AbortSignal.timeout(30_000)]),
      })
      if (signal.aborted) return
      // The provider pass has published its changes. Pull through the normal replica path.
      if (this.#replica.modseq !== null && this.#status.phase !== 'bootstrapping') {
        this.#set({ mailCheck: 'updating' })
        await this.pull()
        if (signal.aborted) return
      }
      if (!ok) throw new Error('Mail check failed')
      this.#recovered('check-mail')
      this.#set({ mailCheck: undefined, mailCheckStartedAt: undefined })
    } catch (error) {
      if (!signal.aborted) {
        this.#set({
          mailCheck: 'failed',
          mailCheckStartedAt: undefined,
          mailCheckFailure: this.#failed('check-mail', error, runId),
        })
      }
    } finally {
      this.#nextMailCheckAt = Date.now() + 5_000
    }
  }

  /** Pull now; coalesces concurrent requests into one extra pull. */
  pull(): Promise<void> {
    const signal = this.#controller.signal
    if (signal.aborted) return Promise.resolve()
    if (this.#pulling) {
      this.#pullAgain = true
      return this.#pulling
    }
    const runId = newRunId()
    mainLog.log('debug', 'desktop.sync.started', { stage: 'pull' }, { runId })
    this.#pulling = (async () => {
      try {
        do {
          this.#pullAgain = false
          try {
            await this.#pullChanges()
          } catch (error) {
            signal.throwIfAborted()
            if (!(error instanceof EngineError && error.code === 'resync_required')) throw error
            this.#failed('bootstrap', error, runId)
            await this.#bootstrap(runId)
            signal.throwIfAborted()
            this.#set({ phase: 'live', progress: null })
            this.#pullAgain = true
          }
        } while (this.#pullAgain && !signal.aborted)
        this.#recovered('pull')
        if (this.#status.phase === 'live' && this.#status.failure) this.#set({ failure: undefined })
      } catch (error) {
        if (!signal.aborted) {
          const failure = this.#failed('pull', error, runId)
          if (this.#status.phase === 'live') this.#set({ failure })
          rememberFailure(error, knownFailure(error) ?? failure)
          throw error
        }
      } finally {
        this.#pulling = null
      }
    })()
    return this.#pulling
  }

  async #refreshHealth(signal: AbortSignal): Promise<void> {
    const refresh = ++this.#healthRefresh
    const runId = newRunId()
    mainLog.log('debug', 'desktop.sync.started', { stage: 'health' }, { runId })
    try {
      const health = await this.#engine.get<Health>('/v1/health', {
        signal: AbortSignal.any([signal, AbortSignal.timeout(10_000)]),
      })
      if (signal.aborted || refresh !== this.#healthRefresh) return
      this.#set({
        healthWarnings: doctorWarnings(health, Date.now(), 'private'),
        healthRefreshFailed: false,
        healthFailure: undefined,
      })
      this.#recovered('health')
    } catch (error) {
      if (signal.aborted || refresh !== this.#healthRefresh) return
      this.#set({ healthRefreshFailed: true, healthFailure: this.#failed('health', error, runId) })
    }
  }

  pullInBackground() {
    void this.pull().catch(() => {
      // Pull records the failure before rejecting. Polling and stream changes retry it.
    })
  }

  #refreshAccountFailures() {
    const accounts = this.#replica.accounts()
    const failures = new Map<string, FailureDetails>()
    for (const account of accounts) {
      if (account.status !== 'error' && account.status !== 'auth_expired') continue
      const last = this.#accountFailures.get(account.id)
      if (last) {
        failures.set(account.id, last)
        continue
      }
      const err = new EngineError(
        0,
        account.status === 'auth_expired' ? 'unauthorized' : 'error',
        'Account sync failed',
      )
      const failure = failureDetails(err, newRunId(), 'Run')
      mainLog.log(
        'error',
        'desktop.sync.failed',
        { stage: 'account', err },
        {
          ...failureScope(failure),
          accountId: account.id,
        },
      )
      failures.set(account.id, failure)
    }
    for (const [accountId, failure] of this.#accountFailures) {
      if (!failures.has(accountId)) {
        mainLog.log(
          'info',
          'desktop.sync.recovered',
          { stage: 'account' },
          {
            ...failureScope(failure),
            accountId,
          },
        )
      }
    }
    if (failures.size || this.#accountFailures.size) {
      this.#accountFailures = failures
      this.#set({ accountFailures: Object.fromEntries(failures) })
    }
  }

  async #run(): Promise<void> {
    const signal = this.#controller.signal
    let backoff = 1000
    while (!signal.aborted) {
      const runId = newRunId()
      let stage: SyncStage = 'connect'
      mainLog.log('debug', 'desktop.sync.started', { stage }, { runId })
      try {
        const me = await this.#engine.get<Me>('/v1/me', {
          signal: AbortSignal.any([signal, AbortSignal.timeout(10_000)]),
        })
        if (signal.aborted) return
        this.#recovered('connect')
        this.#set({ snoozeEnabled: me.features?.snooze === true })
        void this.#refreshHealth(signal)
        if (this.#replica.modseq === null) {
          stage = 'bootstrap'
          await this.#bootstrap(runId)
          this.#set({ phase: 'live', progress: null })
        }
        stage = 'pull'
        await this.pull()
        if (signal.aborted) return
        this.#refreshAccountFailures()
        this.#set({ phase: 'live', error: null, progress: null, failure: undefined })
        backoff = 1000
        const poll = setInterval(() => {
          this.pullInBackground()
          void this.#refreshHealth(signal)
        }, 60_000)
        stage = 'stream'
        mainLog.log('debug', 'desktop.sync.started', { stage }, { runId })
        try {
          await this.#engine.events(
            '/v1/sync/events',
            (event) => {
              if (event === 'change') this.pullInBackground()
            },
            signal,
            () => this.#recovered('stream'),
          )
          if (!signal.aborted) throw new Error('Event stream closed')
        } finally {
          clearInterval(poll)
        }
      } catch (error) {
        if (signal.aborted) return
        const failure = this.#failed(stage, error, runId)
        if (error instanceof EngineError && error.code === 'resync_required') {
          this.#replica.clear({ keepNotificationHistory: true })
          this.emit('changed')
          continue
        }
        if (error instanceof EngineError && error.status === 401) {
          this.#set({
            phase: 'unpaired',
            failure,
            progress: null,
            error:
              'The Engine rejected this pairing. Generate a new desktop pairing code on the Host.',
          })
          return
        }
        const offline = error instanceof EngineError && error.code === 'unreachable'
        this.#set({
          phase: offline ? 'offline' : 'error',
          error: offline ? 'Could not reach the Engine' : 'Sync interrupted',
          failure,
          snoozeEnabled: false,
        })
        await sleep(backoff, signal)
        backoff = Math.min(backoff * 2, 30_000)
      }
    }
  }

  async #bootstrap(runId: RunId): Promise<void> {
    mainLog.log('debug', 'desktop.sync.started', { stage: 'bootstrap' }, { runId })
    const signal = this.#controller.signal
    signal.throwIfAborted()
    this.#set({ phase: 'bootstrapping', progress: 0 })
    const state = await this.#engine.get<SyncState>('/v1/sync/state', { signal })
    signal.throwIfAborted()
    this.#replica.clear({ keepNotificationHistory: true })
    let done = 0
    for (const entity of SNAPSHOT_ORDER) {
      let cursor: string | null = null
      do {
        const query = new URLSearchParams({ entity, limit: '500', ...(cursor ? { cursor } : {}) })
        const page: SyncSnapshotPage = await this.#engine.get(`/v1/sync/snapshot?${query}`, {
          signal,
        })
        signal.throwIfAborted()
        this.#replica.transaction(() => {
          for (const row of page.rows) this.#replica.put(entity, row)
          if (entity === 'thread' || entity === 'message') this.#replica.organise.rebuild()
        })
        cursor = page.cursor
        done += page.rows.length
        this.#set({ progress: Math.min(0.99, done / 20_000) })
        // The inbox is usable as soon as the newest Threads are in.
        this.emit('changed')
      } while (cursor)
    }
    this.#replica.modseq = state.modseq
    this.#replica.organise.rebuild()
    this.#recovered('bootstrap')
  }

  async #pullChanges(): Promise<void> {
    const signal = this.#controller.signal
    for (;;) {
      signal.throwIfAborted()
      const cursor = this.#replica.modseq
      const since = cursor ?? 0
      const res = await this.#engine.get<SyncChanges>(
        `/v1/sync/changes?since=${since}&limit=2000`,
        { signal },
      )
      signal.throwIfAborted()
      if (res.changes.length > 0 || res.modseq !== since) {
        const notifications =
          cursor !== null && this.#status.phase !== 'bootstrapping' && this.listenerCount('newMail')
            ? newInboxMessages(this.#replica, res.changes)
            : []
        let arrivals: Map<string, string> | undefined
        this.#replica.transaction(() => {
          arrivals = this.#replica.apply(res.changes)
          this.#replica.modseq = res.modseq
          if (res.organiseFailures) this.#replica.organise.notice(res.organiseFailures)
          this.#replica.organise.rebuild()
        })
        if (res.changes.some((change) => change.entity === 'account'))
          this.#refreshAccountFailures()
        if (notifications.length) this.emit('newMail', notifications)
        if (arrivals?.size) this.emit('arrivals', arrivals)
        if (res.changes.length > 0 || res.organiseFailures?.length) this.emit('changed')
      }
      this.#set({ lastSyncAt: Date.now() })
      if (!res.more) return
    }
  }
}
