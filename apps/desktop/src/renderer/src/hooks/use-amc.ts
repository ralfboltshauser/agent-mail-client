import { useCallback, useEffect, useRef, useState } from 'react'
import type { SyncStatus } from '../../../shared/api'

/**
 * Loads something from the replica and reloads it whenever sync changes the replica.
 * Keeps the previous value while reloading, so lists never flash empty.
 */
export function useReplica<T>(load: () => Promise<T>, deps: unknown[], initial: T): T {
  const [value, setValue] = useState<T>(initial)
  const loadRef = useRef(load)
  loadRef.current = load
  const generation = useRef(0)

  const refresh = useCallback(() => {
    const mine = ++generation.current
    loadRef
      .current()
      .then((next) => {
        if (mine === generation.current) setValue(next)
      })
      .catch(() => {})
  }, [])

  // biome-ignore lint/correctness/useExhaustiveDependencies: deps are the caller's query inputs
  useEffect(refresh, deps)
  useEffect(() => window.amc.onChanged(refresh), [refresh])
  return value
}

export function useSyncStatus(): SyncStatus | null {
  const [status, setStatus] = useState<SyncStatus | null>(null)
  useEffect(() => {
    void window.amc.status().then(setStatus)
    return window.amc.onStatus(setStatus)
  }, [])
  return status
}
