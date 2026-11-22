import { useCallback, useEffect, useRef, useState } from 'react'

type DeliveryRow = { id: string } & Record<string, string | number | boolean | null>
type PollSnapshot<Row> = { rows?: Row[]; error: string }

function reconcileRows<Row extends DeliveryRow>(previous: Row[] | undefined, incoming: Row[]) {
  if (!previous) return incoming
  const byId = new Map(previous.map((row) => [row.id, row]))
  // Both loaders project IPC replies into flat rows with the same fields.
  const rows = incoming.map((row) => {
    const cached = byId.get(row.id)
    return cached && Object.keys(row).every((key) => row[key] === cached[key]) ? cached : row
  })
  return rows.length === previous.length && rows.every((row, index) => row === previous[index])
    ? previous
    : rows
}

export function useDeliveryPoll<Row extends DeliveryRow>(
  load: () => Promise<Row[]>,
  interval: number,
) {
  const [snapshot, setSnapshot] = useState<PollSnapshot<Row>>({ error: '' })

  const lastSnapshot = useRef(snapshot)
  const refreshPoll = useRef<(() => Promise<void>) | null>(null)
  const refresh = useCallback(async () => {
    await refreshPoll.current?.()
  }, [])

  useEffect(() => {
    let active = true
    let pending: Promise<void> | undefined
    const publish = (next: PollSnapshot<Row>) => {
      lastSnapshot.current = next
      setSnapshot(next)
    }
    const poll = async () => {
      try {
        const incoming = await load()
        if (!active) return
        const previous = lastSnapshot.current
        const rows = reconcileRows(previous.rows, incoming)
        if (rows !== previous.rows || previous.error) publish({ rows, error: '' })
      } catch (cause) {
        if (!active) return
        const error = cause instanceof Error && cause.message ? cause.message : 'Refresh failed.'
        const previous = lastSnapshot.current
        if (previous.error !== error) publish({ ...previous, error })
      }
    }
    const pollOnce = () => {
      pending ??= poll().finally(() => {
        pending = undefined
      })
      return pending
    }

    refreshPoll.current = async () => {
      // A poll already underway may have read the Outbox before the cancellation.
      await pending
      if (active) await pollOnce()
    }
    void pollOnce()
    const timer = window.setInterval(() => void pollOnce(), interval)
    return () => {
      active = false
      refreshPoll.current = null
      window.clearInterval(timer)
    }
  }, [load, interval])

  return { ...snapshot, refresh }
}
