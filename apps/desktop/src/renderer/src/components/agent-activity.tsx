import type { AgentAction } from '@amc/protocol'
import { Activity, ArrowDown, ArrowUp, CircleAlert, RefreshCw, X } from 'lucide-react'
import { useCallback, useLayoutEffect, useMemo, useRef } from 'react'
import { Button } from '@/components/ui/button'
import {
  Dialog,
  DialogClose,
  DialogContent,
  DialogDescription,
  DialogHeader,
  DialogTitle,
} from '@/components/ui/dialog'
import { ActivityEvent, canUndo } from '@/features/agent-activity/activity-event'
import { useAgentActivity } from '@/features/agent-activity/use-agent-activity'
import { MailLoading, MailState } from './mail-state'

const dateFormat = new Intl.DateTimeFormat(undefined, { dateStyle: 'full' })
const noActions: AgentAction[] = []

const failureMessages = {
  load: 'Could not load activity. Try Refresh.',
  undo: 'Could not undo this action. Try Undo again.',
  'undo-refresh': 'Undo was requested. Refresh to check its outcome.',
}

function groupByDate(actions: AgentAction[]) {
  const groups = new Map<string, AgentAction[]>()
  for (const action of actions) {
    const date = dateFormat.format(action.createdAt)
    const group = groups.get(date)
    if (group) group.push(action)
    else groups.set(date, [action])
  }
  return [...groups]
}

export function AgentActivity({
  open,
  onOpenChange,
  onCloseAutoFocus,
}: {
  open: boolean
  onOpenChange: (open: boolean) => void
  onCloseAutoFocus: (event: Event) => void
}) {
  const { page, identities, busy, failure, awaitingUndoRefresh, run } = useAgentActivity(open)
  const actions = page?.actions ?? noActions
  const groups = useMemo(() => groupByDate(actions), [actions])
  const before = page?.before
  const next = page?.nextBefore ?? null
  const viewport = useRef<HTMLElement>(null)
  const visibleCursor = useRef<number | undefined>(undefined)
  const refresh = useRef<HTMLButtonElement>(null)
  const replacedFocus = useRef<Element | null>(null)

  useLayoutEffect(() => {
    if (visibleCursor.current === before) return
    visibleCursor.current = before
    if (viewport.current) viewport.current.scrollTop = 0
  }, [before])

  useLayoutEffect(() => {
    const focused = replacedFocus.current
    if (!focused || busy) return
    replacedFocus.current = null
    if (!focused.isConnected && document.activeElement === document.body) {
      refresh.current?.focus({ preventScroll: true })
    }
  }, [busy])

  const undo = useCallback(
    (id: string) => {
      replacedFocus.current = document.activeElement
      void run(before, id)
    },
    [before, run],
  )

  function navigate(cursor: number | undefined) {
    replacedFocus.current = document.activeElement
    void run(cursor)
  }

  return (
    <Dialog open={open} onOpenChange={onOpenChange}>
      <DialogContent
        onCloseAutoFocus={onCloseAutoFocus}
        onOpenAutoFocus={(event) => {
          event.preventDefault()
          refresh.current?.focus()
        }}
        showCloseButton={false}
        className="flex h-[min(42rem,calc(100dvh-3rem))] flex-col gap-0 overflow-hidden p-0 sm:max-w-[44rem]"
      >
        <DialogHeader className="flex-row items-center justify-between gap-3 border-b px-5 py-4 text-left">
          <div className="flex items-center gap-3">
            <span className="grid size-10 shrink-0 place-items-center rounded-lg bg-muted text-muted-foreground">
              <Activity className="size-5" aria-hidden />
            </span>
            <div className="grid gap-1.5">
              <DialogTitle>Agent activity</DialogTitle>
              <DialogDescription>Review actions Agents took on your mail.</DialogDescription>
            </div>
          </div>
          <div className="flex shrink-0 gap-1.5">
            <Button
              ref={refresh}
              type="button"
              variant="outline"
              className="h-10 aria-disabled:opacity-50"
              aria-disabled={busy}
              onClick={() => {
                if (!busy) navigate(before)
              }}
            >
              <RefreshCw aria-hidden />
              Refresh
            </Button>
            <DialogClose asChild>
              <Button type="button" variant="ghost" size="icon-lg" aria-label="Close">
                <X aria-hidden />
              </Button>
            </DialogClose>
          </div>
        </DialogHeader>
        {failure && (
          <div className="border-b border-destructive/20 bg-destructive/5 px-5 py-2 text-sm">
            <p className="flex items-center gap-2 text-destructive" role="alert">
              <CircleAlert className="size-4 shrink-0" aria-hidden />
              {failureMessages[failure.kind]}
            </p>
            <details className="ml-6 text-xs text-muted-foreground">
              <summary className="w-fit cursor-pointer py-1">Request details</summary>
              <p className="wrap-anywhere">{failure.detail}</p>
            </details>
          </div>
        )}
        <section
          ref={viewport}
          className="min-h-0 flex-1 overflow-y-auto overscroll-contain [scrollbar-gutter:stable] focus-visible:outline-2 focus-visible:-outline-offset-2 focus-visible:outline-ring"
          aria-label="Activity feed"
          aria-busy={busy}
        >
          {groups.map(([date, events]) => (
            <section key={date} className="border-b last:border-b-0">
              <h3 className="border-b bg-muted/55 px-5 py-2.5 text-xs font-semibold text-muted-foreground">
                {date}
              </h3>
              <ul className="divide-y">
                {events.map((action) => (
                  <ActivityEvent
                    key={action.id}
                    action={action}
                    identities={identities}
                    onUndo={undo}
                    undoBlocked={canUndo(action) && (busy || awaitingUndoRefresh)}
                  />
                ))}
              </ul>
            </section>
          ))}
          {!page && busy && <MailLoading label="Loading Agent activity" />}
          {page && !actions.length && (
            <MailState
              icon={Activity}
              title={before === undefined ? 'No Agent activity yet' : 'No older activity'}
            >
              {before === undefined && 'Actions Agents take on your mail will appear here.'}
            </MailState>
          )}
        </section>
        <footer className="flex items-center justify-between gap-3 border-t bg-muted/35 px-5 py-2.5">
          <output className="text-xs text-muted-foreground tabular-nums">
            {busy
              ? page
                ? 'Updating activity…'
                : 'Loading activity…'
              : page
                ? `${actions.length} ${actions.length === 1 ? 'event' : 'events'}`
                : ''}
          </output>
          <nav className="flex gap-1" aria-label="Activity pages">
            <Button
              type="button"
              variant="ghost"
              className="h-10 aria-disabled:opacity-50"
              aria-disabled={busy || before === undefined}
              onClick={() => {
                if (!busy && before !== undefined) navigate(undefined)
              }}
            >
              <ArrowUp aria-hidden />
              Newest
            </Button>
            <Button
              type="button"
              variant="ghost"
              className="h-10 aria-disabled:opacity-50"
              aria-disabled={busy || next === null}
              onClick={() => {
                if (!busy && next !== null) navigate(next)
              }}
            >
              Older
              <ArrowDown aria-hidden />
            </Button>
          </nav>
        </footer>
      </DialogContent>
    </Dialog>
  )
}
