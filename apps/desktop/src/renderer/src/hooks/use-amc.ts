import { useEffect, useMemo, useRef, useSyncExternalStore } from 'react'
import { FIRST_LOAD, type QuerySnapshot, type ReplicaQuery } from '@/data/query-cache'
import { replicaStoreFor } from '@/data/replica-store'
import { selectedSnapshot } from '@/data/selection'
import { messageTextQuery, threadListQuery } from '@/data/thread-queries'
import { getAmc } from '@/lib/amc'
import type { SyncStatus, ThreadQuery } from '../../../shared/api'

function useQuerySource<T>(query: ReplicaQuery<T> | null) {
  const store = replicaStoreFor(getAmc())
  // biome-ignore lint/correctness/useExhaustiveDependencies: the key identifies the loader and all its inputs
  return useMemo(
    () => ({
      read: (): QuerySnapshot<T> => (query ? store.getQuery(query) : FIRST_LOAD),
      subscribe: (listener: () => void) =>
        query ? store.subscribeQuery(query, listener) : () => {},
      refresh: () => {
        if (query) void store.refresh(query)
      },
    }),
    [store, query?.key],
  )
}

export function useReplicaState<T>(query: ReplicaQuery<T> | null) {
  const source = useQuerySource(query)
  const snapshot = useSyncExternalStore(source.subscribe, source.read)
  return { snapshot, refresh: source.refresh }
}

function useSelectedSnapshot<Snapshot, Value>(
  subscribe: (listener: () => void) => () => void,
  read: () => Snapshot,
  select: (snapshot: Snapshot) => Value,
  equal?: (left: Value, right: Value) => boolean,
): Value {
  // Reuse an equal committed selection even when a render supplies a new selector.
  const committed = useRef<{ value: Value } | undefined>(undefined)
  const readSelection = useMemo(
    () => selectedSnapshot(read, select, equal, () => committed.current),
    [read, select, equal],
  )
  const value = useSyncExternalStore(subscribe, readSelection)
  useEffect(() => {
    committed.current = { value }
  }, [value])
  return value
}

export function useReplicaSelector<T, Value>(
  query: ReplicaQuery<T> | null,
  select: (snapshot: QuerySnapshot<T>) => Value,
  equal?: (left: Value, right: Value) => boolean,
): Value {
  const source = useQuerySource(query)
  return useSelectedSnapshot(source.subscribe, source.read, select, equal)
}

export function useThreadIds(query: ThreadQuery) {
  return useReplicaSelector(threadListQuery(getAmc(), query), (snapshot) => snapshot.data?.ids)
}

/** Look up a summary for the same query that established its list membership and order. */
export function useThreadSummary(query: ThreadQuery, id: string) {
  return useReplicaSelector(threadListQuery(getAmc(), query), (snapshot) =>
    snapshot.data?.summaries.get(id),
  )
}

export function useMessageText(id: string, bodyRevision: string) {
  return useReplicaState(messageTextQuery(getAmc(), id, bodyRevision))
}

/** Select a status value. Supply equality when projecting a new object. */
export function useSyncField<Value>(
  select: (status: SyncStatus | null) => Value,
  equal?: (left: Value, right: Value) => boolean,
): Value {
  const store = replicaStoreFor(getAmc())
  const { value, error } = useSelectedSnapshot(
    store.subscribeStatus,
    store.getStatus,
    ({ value, error }) => ({ value: select(value), error }),
    (left, right) => left.error === right.error && (equal ?? Object.is)(left.value, right.value),
  )
  if (error) throw error
  return value
}

function pairingGate(status: SyncStatus | null) {
  if (!status) return { phase: undefined }
  switch (status.phase) {
    case 'unpaired':
      return {
        phase: status.phase,
        engineUrl: status.engineUrl,
        error: status.error,
        failure: status.failure,
      }
    case 'restoring-pairing':
    case 'pairing-read-error':
      return { phase: status.phase, failure: status.failure }
    default:
      return { phase: 'paired' as const, engineUrl: status.engineUrl }
  }
}

type PairingGate = ReturnType<typeof pairingGate>
const sameGate = (left: PairingGate, right: PairingGate) =>
  left.phase === right.phase &&
  left.engineUrl === right.engineUrl &&
  left.error === right.error &&
  left.failure?.id === right.failure?.id

export function usePairingGate() {
  return useSyncField(pairingGate, sameGate)
}
