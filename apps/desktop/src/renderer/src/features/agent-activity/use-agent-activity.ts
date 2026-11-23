import { useCallback, useEffect, useRef, useState } from 'react'
import { getAmc } from '@/lib/amc'
import { failureText, recordCaughtFailure } from '@/lib/failure'
import type { AmcApi } from '../../../../shared/api'

type ActivityPage = Awaited<ReturnType<AmcApi['agentActivity']>> & {
  before?: number
}

export interface ThreadIdentity {
  subject: string
  sender?: string
}

interface Session {
  busy: boolean
  enrichment: number
}

interface ActivityFailure {
  kind: 'load' | 'undo' | 'undo-refresh'
  detail: string
}

// The desktop replica caps summaries() at 100 IDs per call.
const SUMMARY_BATCH_SIZE = 100
const emptyIdentities = new Map<string, ThreadIdentity>()

function retainActions(previous: ActivityPage | null, next: ActivityPage): ActivityPage {
  const byId = new Map(previous?.actions.map((action) => [action.id, action]))
  const actions = next.actions.map((action) => {
    const existing = byId.get(action.id)
    return existing && JSON.stringify(existing) === JSON.stringify(action) ? existing : action
  })
  if (
    previous?.before === next.before &&
    previous?.nextBefore === next.nextBefore &&
    previous.actions.length === actions.length &&
    actions.every((action, index) => previous.actions[index] === action)
  ) {
    return previous
  }
  return { ...next, actions }
}

async function readIdentities(ids: string[]) {
  try {
    const summaries = await getAmc().summaries(ids)
    return summaries.map(({ id, subject, latestSender, participants }) => {
      const sender = latestSender?.from ?? (participants.length === 1 ? participants[0] : undefined)
      return [id, { subject, sender: sender?.name?.trim() || sender?.address }] as const
    })
  } catch (cause) {
    recordCaughtFailure(cause)
    return null
  }
}

export function useAgentActivity(open: boolean) {
  const [page, setPage] = useState<ActivityPage | null>(null)
  const [identities, setIdentities] = useState<ReadonlyMap<string, ThreadIdentity>>(emptyIdentities)
  const [busy, setBusy] = useState(true)
  const [failure, setFailure] = useState<ActivityFailure | null>(null)
  const [awaitingUndoRefresh, setAwaitingUndoRefresh] = useState(false)
  const session = useRef<Session | null>(null)
  const undoInFlight = useRef<Promise<boolean> | null>(null)

  const run = useCallback(async (before?: number, undoId?: string) => {
    const active = session.current
    if (!active || active.busy) return
    active.busy = true
    setBusy(true)
    setFailure(null)
    const stillOpen = () => session.current === active

    let undoAccepted = false
    try {
      if (undoId) {
        const request = Promise.resolve()
          .then(() => getAmc().undoAgentAction(undoId))
          .then(
            () => true,
            (cause: unknown) => {
              if (stillOpen()) setFailure({ kind: 'undo', detail: failureText(cause) })
              return false
            },
          )
        undoInFlight.current = request
        undoAccepted = await request
        undoInFlight.current = null
        if (undoAccepted) setAwaitingUndoRefresh(true)
        if (!undoAccepted || !stillOpen()) return
      } else {
        // A dialog reopened while Undo is in flight should read after the write settles.
        undoAccepted = (await undoInFlight.current) ?? false
        if (!stillOpen()) return
      }

      const result = await getAmc().agentActivity(before)
      if (!stillOpen()) return
      setPage((previous) => retainActions(previous, { ...result, before }))
      setAwaitingUndoRefresh(false)

      const enrichment = ++active.enrichment
      const threads = new Set(result.actions.flatMap(({ threads }) => threads))
      const ids = [...threads]
      // Keep existing names in place during a same-page refresh.
      setIdentities((previous) => {
        if ([...previous.keys()].every((id) => threads.has(id))) return previous
        return new Map([...previous].filter(([id]) => threads.has(id)))
      })
      const batches = Array.from({ length: Math.ceil(ids.length / SUMMARY_BATCH_SIZE) }, (_, i) =>
        ids.slice(i * SUMMARY_BATCH_SIZE, (i + 1) * SUMMARY_BATCH_SIZE),
      )
      void Promise.all(batches.map(readIdentities)).then((results) => {
        if (!stillOpen() || enrichment !== active.enrichment) return
        setIdentities((previous) => {
          const next = new Map(previous)
          results.forEach((result, index) => {
            if (!result) return
            for (const id of batches[index]) next.delete(id)
            for (const [id, identity] of result) next.set(id, identity)
          })
          if (
            next.size === previous.size &&
            [...next].every(([id, identity]) => {
              const current = previous.get(id)
              return current?.subject === identity.subject && current?.sender === identity.sender
            })
          ) {
            return previous
          }
          return next
        })
      })
    } catch (cause) {
      if (stillOpen()) {
        setFailure({ kind: undoAccepted ? 'undo-refresh' : 'load', detail: failureText(cause) })
      }
    } finally {
      active.busy = false
      if (stillOpen()) setBusy(false)
    }
  }, [])

  useEffect(() => {
    if (!open) return
    const active = { busy: false, enrichment: 0 }
    session.current = active
    // Cleanup can invalidate the Strict Mode probe before any IPC starts.
    void Promise.resolve().then(() => {
      if (session.current !== active) return
      setPage(null)
      setIdentities(emptyIdentities)
      void run()
    })
    return () => {
      session.current = null
    }
  }, [open, run])

  return { page, identities, busy, failure, awaitingUndoRefresh, run }
}
