import { useEffect, useState } from 'react'
import { toast } from 'sonner'
import type { TriageStatus } from '../../../shared/api'

export function useTriageStatus() {
  const [status, setStatus] = useState<TriageStatus>()
  useEffect(() => {
    let current = true
    let received = false
    const unsubscribe = window.amc.onTriageStatus((next) => {
      received = true
      setStatus(next)
    })
    void window.amc
      .triageStatus()
      .then((initial) => {
        if (current && !received) setStatus(initial)
      })
      .catch(() => {})
    return () => {
      current = false
      unsubscribe()
    }
  }, [])
  return status
}

export function AutoTriageSetting() {
  const status = useTriageStatus()
  return (
    <label className="flex items-center gap-2 text-sm">
      <input
        type="checkbox"
        checked={status?.enabled ?? true}
        disabled={!status}
        onChange={(event) => {
          void window.amc.setAutoTriage(event.target.checked).catch(() => {
            toast.error('Could not save the auto-triage setting.')
          })
        }}
      />
      Auto-triage new mail
    </label>
  )
}

export function LastTriageRun({ status }: { status: TriageStatus | undefined }) {
  const last = status?.lastRun
  return (
    <output className="block space-y-1 px-2 pb-1 text-xs text-muted-foreground">
      {status?.running ? (
        'Triaging…'
      ) : (
        <>
          {last && (
            <span className="block">
              <time dateTime={new Date(last.at).toISOString()}>
                {new Date(last.at).toLocaleString()}
              </time>
              {last.result && (
                <span className="block">
                  {last.result.assigned} assigned · {last.result.skipped} skipped
                </span>
              )}
              {last.error && <span className="block text-destructive">{last.error}</span>}
            </span>
          )}
          {status?.notice && <span className="block">{status.notice}</span>}
        </>
      )}
    </output>
  )
}
