import type { AmcApi, SyncStatus } from '../../../shared/api'
import { QueryCache, type ReplicaQuery } from './query-cache'
import { shareReply } from './share-reply'

type ReplicaEvents = Pick<AmcApi, 'status' | 'onStatus' | 'onChanged'>
type Listener = () => void

const INITIAL_STATUS = { value: null, error: null }
const canReadReplica = (status: SyncStatus | null) =>
  status !== null &&
  status.phase !== 'unpaired' &&
  status.phase !== 'restoring-pairing' &&
  status.phase !== 'pairing-read-error'

export class ReplicaStore {
  #status: { value: SyncStatus | null; error: Error | null } = INITIAL_STATUS
  #statusListeners = new Set<Listener>()
  #users = 0
  #queryUsers = 0
  #stopStatus?: () => void
  #stopChanged?: () => void
  #resnapshot = false
  #notifications?: Set<Listener>

  #cache = new QueryCache(
    () => canReadReplica(this.#status.value),
    () => this.#resnapshot,
    (listeners) => {
      for (const listener of listeners) {
        if (this.#notifications) this.#notifications.add(listener)
        else listener()
      }
    },
  )

  #api: ReplicaEvents

  constructor(api: ReplicaEvents) {
    this.#api = api
  }

  getStatus = () => this.#status

  subscribeStatus = (listener: Listener) => {
    this.#statusListeners.add(listener)
    this.#retain()
    return () => {
      this.#statusListeners.delete(listener)
      this.#release()
    }
  }

  getQuery<T>(query: ReplicaQuery<T>) {
    return this.#cache.getSnapshot(query)
  }

  isQueryActive<T>(query: ReplicaQuery<T>): boolean {
    return this.#cache.isActive(query)
  }

  subscribeQuery<T>(query: ReplicaQuery<T>, listener: Listener): () => void {
    const unsubscribe = this.#cache.subscribe(query, listener)
    if (++this.#queryUsers === 1) {
      this.#stopChanged = this.#api.onChanged(() =>
        this.#batch(() => this.#cache.invalidate('changed')),
      )
    }
    this.#retain()
    return () => {
      unsubscribe()
      if (--this.#queryUsers === 0) {
        this.#stopChanged?.()
        this.#stopChanged = undefined
      }
      this.#release()
    }
  }

  refresh<T>(query: ReplicaQuery<T>): Promise<void> | undefined {
    return this.#cache.refresh(query)
  }

  #retain(): void {
    if (++this.#users !== 1) return
    let active = true
    let receivedStatus = false
    const unsubscribe = this.#api.onStatus((status) => {
      if (!active) return
      receivedStatus = true
      this.#publishStatus(status)
    })
    this.#stopStatus = () => {
      active = false
      unsubscribe()
    }
    void this.#api.status().then(
      (status) => {
        if (active && !receivedStatus) this.#publishStatus(status)
      },
      (cause: unknown) => {
        if (!active || receivedStatus) return
        this.#status = { value: null, error: new Error('Could not read AMC status', { cause }) }
        for (const listener of this.#statusListeners) listener()
      },
    )
  }

  #release(): void {
    if (--this.#users !== 0) return
    this.#stopStatus?.()
    this.#stopStatus = undefined
    // Without a status listener we cannot detect pairing changes.
    this.#status = INITIAL_STATUS
    this.#resnapshot = false
    this.#cache.reset()
  }

  #publishStatus(status: SyncStatus): void {
    const previous = this.#status.value
    const next = shareReply(previous ?? undefined, status)
    if (previous === next) return

    const pairingChanged =
      canReadReplica(previous) !== canReadReplica(next) ||
      (previous !== null && previous.engineUrl !== next.engineUrl)
    const wasResnapshot = this.#resnapshot
    this.#resnapshot =
      next.phase === 'bootstrapping' || (wasResnapshot && !pairingChanged && next.phase !== 'live')
    this.#status = { value: next, error: null }

    this.#batch(() => {
      if (pairingChanged) {
        this.#cache.reset()
        this.#cache.invalidate('pairing')
      } else if (wasResnapshot !== this.#resnapshot) {
        this.#cache.invalidate('bootstrap')
      }
      for (const listener of this.#statusListeners) this.#notifications?.add(listener)
    })
  }

  #batch(update: () => void): void {
    if (this.#notifications) {
      update()
      return
    }
    const notifications = new Set<Listener>()
    this.#notifications = notifications
    try {
      update()
    } finally {
      this.#notifications = undefined
    }
    for (const notify of notifications) notify()
  }
}

const stores = new WeakMap<AmcApi, ReplicaStore>()

export function replicaStoreFor(api: AmcApi): ReplicaStore {
  let store = stores.get(api)
  if (!store) {
    store = new ReplicaStore(api)
    stores.set(api, store)
  }
  return store
}
