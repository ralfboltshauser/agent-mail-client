import { EventEmitter } from 'node:events'
import type { SyncChanges, SyncEntity, SyncSnapshotPage, SyncState } from '@amc/protocol'
import type { SyncStatus } from '../shared/api'
import { type EngineClient, EngineError } from './engine'
import type { Replica } from './replica'

const SNAPSHOT_ORDER: SyncEntity[] = ['account', 'label', 'draft', 'thread', 'message']
const sleep = (ms: number, signal: AbortSignal) =>
  new Promise<void>((resolve) => {
    const t = setTimeout(resolve, ms)
    signal.addEventListener('abort', () => {
      clearTimeout(t)
      resolve()
    })
  })

/**
 * Keeps the replica in step with the Engine: bootstrap from a snapshot, then pull changes
 * whenever the event stream says something changed (and every minute, in case it says nothing).
 */
export class SyncLoop extends EventEmitter<{ status: [SyncStatus]; changed: [] }> {
  readonly #engine: EngineClient
  readonly #replica: Replica
  readonly #controller = new AbortController()
  #status: SyncStatus
  #pulling: Promise<void> | null = null
  #pullAgain = false

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
    void this.#run()
  }

  stop(): void {
    this.#controller.abort()
  }

  /** Pull now; coalesces concurrent requests into one extra pull. */
  pull(): Promise<void> {
    if (this.#pulling) {
      this.#pullAgain = true
      return this.#pulling
    }
    this.#pulling = (async () => {
      try {
        do {
          this.#pullAgain = false
          await this.#pullChanges()
        } while (this.#pullAgain)
      } finally {
        this.#pulling = null
      }
    })()
    return this.#pulling
  }

  async #run(): Promise<void> {
    const signal = this.#controller.signal
    let backoff = 1000
    while (!signal.aborted) {
      try {
        if (this.#replica.modseq === null) await this.#bootstrap()
        await this.pull()
        this.#set({ phase: 'live', error: null, progress: null })
        backoff = 1000
        const poll = setInterval(() => void this.pull().catch(() => {}), 60_000)
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
          continue
        }
        const offline = error instanceof EngineError && error.code === 'unreachable'
        this.#set({ phase: offline ? 'offline' : 'error', error: (error as Error).message })
        await sleep(backoff, signal)
        backoff = Math.min(backoff * 2, 30_000)
      }
    }
  }

  async #bootstrap(): Promise<void> {
    this.#set({ phase: 'bootstrapping', progress: 0 })
    const state = await this.#engine.get<SyncState>('/v1/sync/state')
    this.#replica.clear()
    let done = 0
    for (const entity of SNAPSHOT_ORDER) {
      let cursor: string | null = null
      do {
        const query = new URLSearchParams({ entity, limit: '500', ...(cursor ? { cursor } : {}) })
        const page: SyncSnapshotPage = await this.#engine.get(`/v1/sync/snapshot?${query}`)
        this.#replica.transaction(() => {
          for (const row of page.rows) this.#replica.put(entity, row)
        })
        cursor = page.cursor
        done += page.rows.length
        this.#set({ progress: Math.min(0.99, done / 20_000) })
        // The inbox is usable as soon as the newest Threads are in.
        this.emit('changed')
      } while (cursor)
    }
    this.#replica.modseq = state.modseq
  }

  async #pullChanges(): Promise<void> {
    for (;;) {
      const since = this.#replica.modseq ?? 0
      const res = await this.#engine.get<SyncChanges>(`/v1/sync/changes?since=${since}&limit=2000`)
      if (res.changes.length > 0 || res.modseq !== since) {
        this.#replica.transaction(() => {
          this.#replica.apply(res.changes)
          this.#replica.modseq = res.modseq
        })
        if (res.changes.length > 0) this.emit('changed')
      }
      this.#set({ lastSyncAt: Date.now() })
      if (!res.more) return
    }
  }
}
