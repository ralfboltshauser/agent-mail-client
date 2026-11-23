import { CircleAlert } from 'lucide-react'
import { useEffect, useMemo, useState } from 'react'
import { toast } from 'sonner'
import { Button } from '@/components/ui/button'
import { SidebarGroupLabel } from '@/components/ui/sidebar'
import { replicaStoreFor } from '@/data/replica-store'
import { useReplicaSelector, useSyncField } from '@/hooks/use-amc'
import { getAmc } from '@/lib/amc'
import { failureText } from '@/lib/failure'
import type { TriageStatus } from '../../../shared/api'
import { formatFailure } from '../../../shared/failure'

export function useTriageStatus() {
  const [status, setStatus] = useState<TriageStatus>()
  useEffect(() => {
    let current = true
    let received = false
    const unsubscribe = getAmc().onTriageStatus((next) => {
      received = true
      setStatus(next)
    })
    void getAmc()
      .triageStatus()
      .then((initial) => {
        if (current && !received) setStatus(initial)
      })
      .catch((error: unknown) => {
        if (current && !received)
          toast.error('Could not load triage status', {
            id: 'triage-status',
            description: failureText(error),
          })
      })
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
          void getAmc()
            .setAutoTriage(event.target.checked)
            .catch((error: unknown) => {
              toast.error('Could not save the auto-triage setting', {
                description: failureText(error),
              })
            })
        }}
      />
      Auto-triage new mail
    </label>
  )
}

export function SidebarTriage({ accountId }: { accountId: string | null }) {
  const triage = useTriageStatus()
  const api = getAmc()
  const query = useMemo(
    () => ({
      key: JSON.stringify(['triage-counts', accountId]),
      load: () => api.triageCounts(accountId),
    }),
    [api, accountId],
  )
  const counts = useReplicaSelector(query, ({ data }) => data)
  useEffect(() => {
    const timer = setInterval(() => void replicaStoreFor(api).refresh(query), 60_000)
    return () => clearInterval(timer)
  }, [api, query])

  const syncIsLive = useSyncField((status) => status?.phase === 'live')
  const disabled = !syncIsLive || !triage || triage.running
  const runTriage = (scope: 'recent' | 'account') => {
    void api
      .triageNow(accountId, scope)
      .catch((error: unknown) =>
        toast.error('Could not start triage', { description: failureText(error) }),
      )
  }

  return (
    <section aria-label="Triage" className="mx-2 mb-2 flex min-w-0 flex-col gap-1.5">
      <div>
        <SidebarGroupLabel asChild className="px-0 text-sidebar-foreground">
          <h2>Triage</h2>
        </SidebarGroupLabel>
        {counts && (
          <p className="flex flex-wrap gap-x-3 text-xs leading-4 text-muted-foreground tabular-nums">
            <span>{counts.recent.toLocaleString()} new</span>
            <span>{counts.older.toLocaleString()} older</span>
          </p>
        )}
      </div>
      <div className="flex flex-wrap gap-1">
        <Button
          type="button"
          variant="secondary"
          size="xs"
          className="px-1.5"
          disabled={disabled}
          onClick={() => runTriage('recent')}
          title="Triage Inbox Threads delivered in the last 24 hours"
        >
          Run recent
        </Button>
        <Button
          type="button"
          variant="outline"
          size="xs"
          className="px-1.5 shadow-none"
          disabled={disabled || counts?.older === 0}
          onClick={() => runTriage('account')}
          title="Include older untriaged Inbox Threads in the next batch"
        >
          Run older…
        </Button>
      </div>
      <LastTriageRun status={triage} syncIsLive={syncIsLive} />
    </section>
  )
}

function LastTriageRun({
  status,
  syncIsLive,
}: {
  status: TriageStatus | undefined
  syncIsLive: boolean
}) {
  const last = status?.running ? null : status?.lastRun
  const error = last?.error
  const notice = status?.running ? null : status?.notice
  const date = last && new Date(last.at)
  const timestamp = date && (
    <time dateTime={date.toISOString()}>
      {date.toLocaleString(undefined, { dateStyle: 'medium', timeStyle: 'short' })}
    </time>
  )

  return (
    <div
      className={
        error
          ? 'rounded-md bg-destructive/8 px-2 py-1.5 text-xs leading-4 wrap-anywhere'
          : 'text-xs leading-4 wrap-anywhere'
      }
    >
      <output className="block space-y-0.5 text-muted-foreground">
        {status?.running ? (
          <span className="block">Triaging…</span>
        ) : error ? (
          <span className="flex items-start gap-1.5 font-medium text-foreground">
            <CircleAlert aria-hidden="true" className="mt-px size-3.5 shrink-0 text-destructive" />
            Triage failed
          </span>
        ) : last ? (
          <span className="block">
            Last run {timestamp}
            {last.result && (
              <span className="flex flex-wrap gap-x-2 tabular-nums">
                <span>{last.result.assigned.toLocaleString()} assigned</span>
                <span>{last.result.skipped.toLocaleString()} skipped</span>
              </span>
            )}
          </span>
        ) : !notice ? (
          <span className="block">
            {syncIsLive
              ? status
                ? 'No triage runs yet'
                : 'Loading triage status…'
              : 'Waiting for Engine sync'}
          </span>
        ) : null}
        {notice && <span className="block">{notice}</span>}
      </output>
      {error && (
        <details className="mt-0.5 pl-5">
          <summary className="w-fit cursor-pointer rounded-sm text-muted-foreground hover:text-foreground focus-visible:outline-2 focus-visible:outline-ring">
            Details
          </summary>
          <div className="mt-1 space-y-0.5 text-foreground">
            <p className="text-muted-foreground">Last run {timestamp}</p>
            <p>{error}</p>
            {last?.failure && (
              <p className="select-text break-all font-mono">{formatFailure(last.failure)}</p>
            )}
          </div>
        </details>
      )}
    </div>
  )
}
