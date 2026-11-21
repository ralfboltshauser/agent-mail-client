import type { AccountSummary } from '@amc/protocol'
import { useEffect, useState } from 'react'
import { Tooltip, TooltipContent, TooltipTrigger } from '@/components/ui/tooltip'
import { cn } from '@/lib/utils'
import type { SyncStatus } from '../../../shared/api'

function ago(ms: number, now: number) {
  const s = Math.max(0, Math.round((now - ms) / 1000))
  if (s < 10) return 'just now'
  if (s < 60) return `${s}s ago`
  if (s < 3600) return `${Math.round(s / 60)}m ago`
  return `${Math.round(s / 3600)}h ago`
}

/** One honest line about sync: live, catching up, offline, or what is wrong. */
export function SyncIndicator({
  status,
  accounts,
}: {
  status: SyncStatus | null
  accounts: AccountSummary[]
}) {
  const [now, setNow] = useState(Date.now())
  useEffect(() => {
    const t = setInterval(() => setNow(Date.now()), 5000)
    return () => clearInterval(t)
  }, [])
  if (!status) return null

  const backfilling = accounts.filter((a) => a.status === 'backfilling')
  const broken = accounts.filter((a) => a.status === 'error' || a.status === 'auth_expired')
  let tone: 'ok' | 'busy' | 'bad' = 'ok'
  let text = status.lastSyncAt ? `Up to date · ${ago(status.lastSyncAt, now)}` : 'Connecting…'
  if (status.phase === 'paused') {
    tone = 'busy'
    text = 'Sync paused'
  } else if (status.phase === 'bootstrapping') {
    tone = 'busy'
    text = `Downloading mail${status.progress ? ` · ${Math.round(status.progress * 100)}%` : '…'}`
  } else if (status.phase === 'offline') {
    tone = 'bad'
    text = 'Engine unreachable · retrying'
  } else if (status.phase === 'error') {
    tone = 'bad'
    text = 'Sync error'
  } else if (broken.length > 0) {
    tone = 'bad'
    text = broken[0]?.status === 'auth_expired' ? 'Sign in again needed' : 'Account sync error'
  } else if (backfilling.length > 0) {
    tone = 'busy'
    const a = backfilling[0]
    text = `Fetching history · ${a?.messageCount.toLocaleString()}${a?.backfill.estimatedTotal ? ` of ${a.backfill.estimatedTotal.toLocaleString()}` : ''}`
  }

  const detail = [
    status.error,
    ...broken.map((a) => `${a.address}: ${a.lastError ?? a.status}`),
    status.engineUrl,
  ]
    .filter(Boolean)
    .join('\n')

  return (
    <Tooltip>
      <TooltipTrigger asChild>
        <div className="flex items-center gap-2 px-2 py-1.5 text-xs text-muted-foreground">
          <span
            className={cn(
              'size-1.5 shrink-0 rounded-full',
              tone === 'ok' && 'bg-emerald-500',
              tone === 'busy' && 'animate-pulse bg-amber-500',
              tone === 'bad' && 'bg-destructive',
            )}
          />
          <span className="truncate tabular-nums">{text}</span>
        </div>
      </TooltipTrigger>
      {detail && (
        <TooltipContent side="top" className="max-w-80 whitespace-pre-line">
          {detail}
        </TooltipContent>
      )}
    </Tooltip>
  )
}
