import { shareReply } from './share-reply'

export interface ReplicaQuery<T> {
  // A key identifies both the data type and all inputs to its loader.
  key: string | object
  load: (previous: T | undefined) => Promise<T>
  isEmpty?: (value: T) => boolean
  retainDuringBootstrap?: 'defer-reads' | 'keep-reading'
  versioned?: boolean
  // Opaque legacy loaders retain their immediate replacement on change events.
  replacePending?: boolean
}

export type QuerySnapshot<T> =
  | { state: 'first-load'; data?: undefined; error?: undefined }
  | { state: 'first-error'; data?: undefined; error: unknown }
  | { state: 'cached' | 'empty-success' | 'cached+refreshing'; data: T; error?: undefined }
  | { state: 'cached+error'; data: T; error: unknown }

type Listener = () => void
const reusableVersion = <T>(snapshot: QuerySnapshot<T>) =>
  snapshot.state === 'cached' || snapshot.state === 'cached+refreshing'
type Entry<T = unknown> = {
  snapshot: QuerySnapshot<T>
  listeners: Set<Listener>
  generation: number
  pending?: Promise<void>
  active?: {
    refresh: () => Promise<void> | undefined
    versioned?: boolean
    retainDuringBootstrap?: 'defer-reads' | 'keep-reading'
    replacePending?: boolean
  }
}

export const FIRST_LOAD = { state: 'first-load' } as const
const hasData = <T>(
  snapshot: QuerySnapshot<T>,
): snapshot is Extract<QuerySnapshot<T>, { data: T }> =>
  snapshot.state !== 'first-load' && snapshot.state !== 'first-error'
const CACHED_INACTIVE_QUERIES = 16
const isEmpty = (value: unknown) => value === null || (Array.isArray(value) && value.length === 0)

export class QueryCache {
  #entries = new Map<ReplicaQuery<unknown>['key'], Entry>()

  #canRead: () => boolean
  #isBootstrapping: () => boolean
  #notify: (listeners: Set<Listener>) => void

  constructor(
    canRead: () => boolean,
    isBootstrapping: () => boolean,
    notify: (listeners: Set<Listener>) => void,
  ) {
    this.#canRead = canRead
    this.#isBootstrapping = isBootstrapping
    this.#notify = notify
  }

  getSnapshot<T>(query: ReplicaQuery<T>): QuerySnapshot<T> {
    return this.#entry(query)?.snapshot ?? FIRST_LOAD
  }

  subscribe<T>(query: ReplicaQuery<T>, listener: Listener): () => void {
    const entry = this.#entry(query) ?? this.#create(query)
    if (!entry.active) {
      entry.active = {
        refresh: () => this.#refresh(query, entry),
        versioned: query.versioned,
        retainDuringBootstrap: query.retainDuringBootstrap,
        replacePending: query.replacePending,
      }
      if (!query.versioned || !reusableVersion(entry.snapshot)) entry.active.refresh()
    }
    const notify = () => listener()
    entry.listeners.add(notify)
    return () => {
      if (!entry.listeners.delete(notify)) return
      if (entry.listeners.size) return
      entry.active = undefined
      // Inactive entries are ordered by when they were last used.
      this.#entries.delete(query.key)
      this.#entries.set(query.key, entry)
      this.#prune()
    }
  }

  refresh<T>(query: ReplicaQuery<T>): Promise<void> | undefined {
    return this.#entry(query)?.active?.refresh()
  }

  invalidate(reason: 'changed' | 'pairing' | 'bootstrap'): void {
    for (const entry of this.#entries.values()) {
      const active = entry.active
      if (!active) continue
      if (reason === 'bootstrap' && !active.retainDuringBootstrap) continue
      if (reason === 'changed' && active.versioned && reusableVersion(entry.snapshot)) continue

      // Reject the pre-change generation. Typed queries wait for it to settle before retrying.
      if (entry.pending) {
        entry.generation++
        if (!active.replacePending) continue
        entry.pending = undefined
      }
      active.refresh()
    }
  }

  reset(): void {
    for (const [key, entry] of this.#entries) {
      entry.generation++
      entry.pending = undefined
      this.#publish(entry, FIRST_LOAD)
      if (!entry.active) this.#entries.delete(key)
    }
  }

  #entry<T>(query: ReplicaQuery<T>): Entry<T> | undefined {
    return this.#entries.get(query.key) as Entry<T> | undefined
  }

  #create<T>(query: ReplicaQuery<T>): Entry<T> {
    const entry = { snapshot: FIRST_LOAD, listeners: new Set<Listener>(), generation: 0 }
    this.#entries.set(query.key, entry)
    return entry
  }

  #refresh<T>(query: ReplicaQuery<T>, entry: Entry<T>): Promise<void> | undefined {
    if (entry.pending || !this.#canRead()) return entry.pending
    const snapshot = entry.snapshot
    const { data } = snapshot
    const empty = query.isEmpty ?? isEmpty
    const partial = () => query.retainDuringBootstrap !== undefined && this.#isBootstrapping()
    const hasPopulatedData = hasData(snapshot) && !empty(snapshot.data)
    if (partial() && hasPopulatedData && query.retainDuringBootstrap === 'defer-reads') {
      this.#publish(entry, { state: 'cached+refreshing', data: snapshot.data })
      return
    }

    const generation = entry.generation
    const pending = Promise.resolve()
      .then(async () => {
        if (entry.generation !== generation) return
        let reply: T
        try {
          reply = await query.load(data)
        } catch (error) {
          if (entry.generation !== generation || (partial() && hasPopulatedData)) return
          this.#publish(
            entry,
            hasData(snapshot)
              ? { state: 'cached+error', data: snapshot.data, error }
              : { state: 'first-error', error },
          )
          return
        }
        if (entry.generation !== generation || (partial() && hasPopulatedData)) return
        const next = shareReply(data, reply)
        if (partial() && empty(next)) {
          // The replica can be temporarily empty between snapshot pages.
          this.#publish(
            entry,
            hasData(snapshot) ? { state: 'empty-success', data: snapshot.data } : FIRST_LOAD,
          )
          return
        }
        this.#publish(entry, { state: empty(next) ? 'empty-success' : 'cached', data: next })
      })
      .finally(() => {
        if (entry.pending !== pending) return
        entry.pending = undefined
        if (entry.generation !== generation) entry.active?.refresh()
      })
    entry.pending = pending
    this.#publish(
      entry,
      hasData(snapshot) ? { state: 'cached+refreshing', data: snapshot.data } : FIRST_LOAD,
    )
    return pending
  }

  #publish<T>(entry: Entry<T>, snapshot: QuerySnapshot<T>): void {
    const previous = entry.snapshot
    if (
      previous.state === snapshot.state &&
      Object.is(previous.data, snapshot.data) &&
      Object.is(previous.error, snapshot.error)
    )
      return
    entry.snapshot = snapshot
    this.#notify(entry.listeners)
  }

  #prune(): void {
    let excess =
      [...this.#entries.values()].filter((entry) => !entry.active).length - CACHED_INACTIVE_QUERIES
    if (excess <= 0) return
    for (const [key, entry] of this.#entries) {
      if (entry.active) continue
      entry.generation++
      this.#entries.delete(key)
      if (--excess === 0) break
    }
  }
}
