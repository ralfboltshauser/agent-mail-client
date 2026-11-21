import { EventEmitter } from 'node:events'
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
import { type EngineClient, EngineError } from './engine'
import { newInboxMessages } from './notifications'
import type { Replica } from './replica'

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
}> {
  readonly #engine: EngineClient
  readonly #replica: Replica
  readonly #controller = new AbortController()
  readonly #startedAt: number
  #status: SyncStatus
  #pulling: Promise<void> | null = null
  #pullAgain = false

  constructor(engine: EngineClient, replica: Replica, startedAt: number) {
    super()
    this.#engine = engine
    this.#replica = replica
    this.#startedAt = startedAt
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
    void this.#run()
  }

  stop(): void {
    this.#controller.abort()
  }

  /** Pull now; coalesces concurrent requests into one extra pull. */
  pull(): Promise<void> {
    const signal = this.#controller.signal
    if (signal.aborted) return Promise.resolve()
    if (this.#pulling) {
      this.#pullAgain = true
      return this.#pulling
    }
    this.#pulling = (async () => {
      try {
        do {
          this.#pullAgain = false
          try {
            await this.#pullChanges()
          } catch (error) {
            signal.throwIfAborted()
            if (!(error instanceof EngineError && error.code === 'resync_required')) throw error
            await this.#bootstrap()
            signal.throwIfAborted()
            this.#set({ phase: 'live', progress: null })
            this.#pullAgain = true
          }
        } while (this.#pullAgain && !signal.aborted)
      } catch (error) {
        if (!signal.aborted) throw error
      } finally {
        this.#pulling = null
      }
    })()
    return this.#pulling
  }

  async #refreshHealth(signal: AbortSignal): Promise<void> {
    const health = await this.#engine
      .get<Health>('/v1/health', { signal: AbortSignal.any([signal, AbortSignal.timeout(10_000)]) })
      .catch(() => null)
    if (health && !signal.aborted) this.#set({ healthWarnings: doctorWarnings(health) })
  }

  async #run(): Promise<void> {
    const signal = this.#controller.signal
    let backoff = 1000
    while (!signal.aborted) {
      try {
        const me = await this.#engine.get<Me>('/v1/me', { signal })
        if (signal.aborted) return
        this.#set({ snoozeEnabled: me.features?.snooze === true })
        void this.#refreshHealth(signal)
        if (this.#replica.modseq === null) await this.#bootstrap()
        await this.pull()
        if (signal.aborted) return
        this.#set({ phase: 'live', error: null, progress: null })
        backoff = 1000
        const poll = setInterval(() => {
          void this.pull().catch(() => {})
          void this.#refreshHealth(signal)
        }, 60_000)
        try {
          await this.#engine.events(
            '/v1/sync/events',
            (event) => {
              if (event === 'change') void this.pull().catch(() => {})
            },
            signal,
          )
        } finally {
          clearInterval(poll)
        }
      } catch (error) {
        if (signal.aborted) return
        if (error instanceof EngineError && error.code === 'resync_required') {
          this.#replica.clear()
          this.emit('changed')
          continue
        }
        const offline = error instanceof EngineError && error.code === 'unreachable'
        this.#set({
          phase: offline ? 'offline' : 'error',
          error: (error as Error).message,
          snoozeEnabled: false,
        })
        await sleep(backoff, signal)
        backoff = Math.min(backoff * 2, 30_000)
      }
    }
  }

  async #bootstrap(): Promise<void> {
    const signal = this.#controller.signal
    signal.throwIfAborted()
    this.#set({ phase: 'bootstrapping', progress: 0 })
    const state = await this.#engine.get<SyncState>('/v1/sync/state', { signal })
    signal.throwIfAborted()
    this.#replica.clear()
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
        const arrivals =
          cursor !== null && this.#status.phase !== 'bootstrapping' && this.listenerCount('newMail')
            ? newInboxMessages(this.#replica, res.changes, this.#startedAt)
            : []
        this.#replica.transaction(() => {
          this.#replica.apply(res.changes)
          this.#replica.modseq = res.modseq
          if (res.organiseFailures) this.#replica.organise.notice(res.organiseFailures)
          this.#replica.organise.rebuild()
        })
        if (arrivals.length) this.emit('newMail', arrivals)
        if (res.changes.length > 0 || res.organiseFailures?.length) this.emit('changed')
      }
      this.#set({ lastSyncAt: Date.now() })
      if (!res.more) return
    }
  }
}
