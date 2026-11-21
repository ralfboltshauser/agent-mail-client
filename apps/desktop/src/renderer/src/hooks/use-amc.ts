import { useCallback, useEffect, useRef, useState } from 'react'
import { getAmc } from '@/lib/amc'
import type { SyncStatus } from '../../../shared/api'

/**
 * Loads something from the replica and reloads it whenever sync changes the replica.
 * Keeps the previous value while reloading, so lists never flash empty.
 */
export function useReplica<T>(load: () => Promise<T>, deps: unknown[], initial: T): T {
  return useReplicaQuery(load, deps, initial).value
}

export function useReplicaQuery<T>(load: () => Promise<T>, deps: unknown[], initial: T) {
  const [value, setValue] = useState<T>(initial)
  const [failed, setFailed] = useState(false)
  const loadRef = useRef(load)
  loadRef.current = load
  const generation = useRef(0)

  const refresh = useCallback(() => {
    const mine = ++generation.current
    setFailed(false)
    loadRef
      .current()
      .then((next) => {
        if (mine === generation.current) setValue(next)
      })
      .catch(() => {
        if (mine === generation.current) setFailed(true)
      })
  }, [])

  // biome-ignore lint/correctness/useExhaustiveDependencies: deps are the caller's query inputs
  useEffect(refresh, deps)
  useEffect(() => getAmc().onChanged(refresh), [refresh])
  return { value, failed, refresh }
}

export function useSyncStatus(): SyncStatus | null {
  const [status, setStatus] = useState<SyncStatus | null>(null)
  const [error, setError] = useState<Error | null>(null)
  useEffect(() => {
    const amc = getAmc()
    let active = true
    let receivedStatus = false
    const unsubscribe = amc.onStatus((next) => {
      receivedStatus = true
      setStatus(next)
      setError(null)
    })
    void amc.status().then(
      (next) => {
        if (active && !receivedStatus) setStatus(next)
      },
      (cause: unknown) => {
        if (active && !receivedStatus) setError(new Error('Could not read AMC status', { cause }))
      },
    )
    return () => {
      active = false
      unsubscribe()
    }
  }, [])
  if (error) throw error
  return status
}
