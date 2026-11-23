import { TriangleAlert } from 'lucide-react'
import { useEffect, useState } from 'react'
import { Tooltip, TooltipContent, TooltipTrigger } from '@/components/ui/tooltip'
import { shareReply } from '@/data/share-reply'
import { accountsQuery } from '@/features/mailbox/mailbox-queries'
import { useReplicaSelector, useSyncField } from '@/hooks/use-amc'
import { cn } from '@/lib/utils'
import type { SyncStatus } from '../../../shared/api'

function ago(ms: number, now: number) {
  const s = Math.max(0, Math.round((now - ms) / 1000))
  if (s < 10) return 'just now'
  if (s < 60) return `${s}s ago`
  if (s < 3600) return `${Math.round(s / 60)}m ago`
  return `${Math.round(s / 3600)}h ago`
}

function indicatorStatus(status: SyncStatus | null) {
  if (!status) return null
  const {
    phase,
    progress,
    lastSyncAt,
    error,
    engineUrl,
    healthWarnings,
    healthRefreshFailed,
    mailCheck,
  } = status
  return {
    phase,
    progress,
    lastSyncAt,
    error,
    engineUrl,
    healthWarnings,
    healthRefreshFailed,
    mailCheck,
  }
}

/** One honest line about sync: live, catching up, offline, or what is wrong. */
export function SyncIndicator() {
  const status = useSyncField(indicatorStatus, (left, right) => shareReply(left, right) === left)
  const { backfilling, broken } = useReplicaSelector(
    accountsQuery(),
    ({ data = [] }) => {
      const account = data.find((a) => a.status === 'backfilling')
      return {
        backfilling: account && {
          messageCount: account.messageCount,
          estimatedTotal: account.backfill.estimatedTotal,
        },
        broken: data
          .filter((a) => a.status === 'error' || a.status === 'auth_expired')
          .map((a) => ({ address: a.address, status: a.status, lastError: a.lastError })),
      }
    },
    (left, right) => shareReply(left, right) === left,
  )
  const [now, setNow] = useState(Date.now())
  useEffect(() => {
    const t = setInterval(() => setNow(Date.now()), 5000)
    return () => clearInterval(t)
  }, [])
  if (!status) return null

  let tone: 'ok' | 'busy' | 'bad' = 'ok'
  let text = status.lastSyncAt ? `Up to date · ${ago(status.lastSyncAt, now)}` : 'Connecting…'
  if (status.phase === 'paused') {
    tone = 'busy'
    text = 'Sync paused'
  } else if (status.phase === 'bootstrapping') {
    tone = 'busy'
    text = `Downloading mail${status.progress ? ` · ${Math.round(status.progress * 100)}%` : '…'}`
  } else if (status.mailCheck === 'checking') {
    tone = 'busy'
    text = 'Checking for new mail…'
  } else if (status.phase === 'offline' || status.phase === 'error') {
    tone = 'bad'
    text = 'Reconnecting…'
  } else if (broken.length > 0) {
    tone = 'bad'
    text = broken[0]?.status === 'auth_expired' ? 'Sign in again needed' : 'Account sync error'
  } else if (status.mailCheck === 'failed') {
    tone = 'bad'
    text = 'Could not check for new mail'
  } else if (backfilling) {
    tone = 'busy'
    text = `Fetching history · ${backfilling.messageCount.toLocaleString()}${backfilling.estimatedTotal ? ` of ${backfilling.estimatedTotal.toLocaleString()}` : ''}`
  }

  const healthUnavailable = status.healthRefreshFailed === true
  const warnings = healthUnavailable ? [] : (status.healthWarnings ?? [])
  const detail = [
    ...warnings,
    status.error,
    ...broken.map((a) => `${a.address}: ${a.lastError ?? a.status}`),
    status.engineUrl,
  ].filter(Boolean)
  const tooltip = [...new Set(detail)].join('\n')

  return (
    <Tooltip>
      <TooltipTrigger asChild>
        <div
          tabIndex={tooltip ? 0 : undefined}
          className="grid gap-1 rounded-md px-2 py-1.5 text-[11px] text-muted-foreground"
        >
          <div className="flex items-center gap-2">
            <span
              aria-hidden
              className={cn(
                'size-1.5 shrink-0 rounded-full',
                tone === 'ok' && 'bg-emerald-500',
                tone === 'busy' && 'motion-safe:animate-pulse bg-star',
                tone === 'bad' && 'bg-destructive',
              )}
            />
            <span className="truncate tabular-nums">{text}</span>
          </div>
          {(healthUnavailable || warnings.length > 0) && (
            <output className="flex items-center gap-1.5 text-star">
              <TriangleAlert aria-hidden className="size-3 shrink-0" />
              {healthUnavailable ? 'Engine health unavailable' : 'Engine health warning'}
            </output>
          )}
        </div>
      </TooltipTrigger>
      {tooltip && (
        <TooltipContent side="top" className="max-w-80 whitespace-pre-line">
          {tooltip}
        </TooltipContent>
      )}
    </Tooltip>
  )
}
