import { isCorrelationId } from '@amc/observability'
import type { AgentAction } from '@amc/protocol'
import { Check, ChevronRight, CircleAlert, Clock, Minus, Undo2 } from 'lucide-react'
import { memo, useId, useState } from 'react'
import { Button } from '@/components/ui/button'
import { cn } from '@/lib/utils'
import type { ThreadIdentity } from './use-agent-activity'

const operationNames: Readonly<Record<string, string>> = {
  set_bucket: 'Assign Bucket',
  archive: 'Archive',
  mark_read: 'Mark as read',
  mark_unread: 'Mark as unread',
  star: 'Star',
  unstar: 'Unstar',
  add_label: 'Add Label',
  remove_label: 'Remove Label',
  mute: 'Mute',
  create_draft: 'Create draft',
  update_draft: 'Update draft',
}

const outcomes = {
  applied: { label: 'Applied', icon: Check, style: 'bg-muted text-muted-foreground' },
  pending: { label: 'Pending', icon: Clock, style: 'bg-muted text-muted-foreground' },
  partial: {
    label: 'Partially applied',
    icon: CircleAlert,
    style: 'bg-accent text-accent-foreground',
  },
  failed: { label: 'Failed', icon: CircleAlert, style: 'bg-destructive/10 text-destructive' },
  rejected: { label: 'Rejected', icon: Minus, style: 'bg-destructive/10 text-destructive' },
}

const timeFormat = new Intl.DateTimeFormat(undefined, { hour: '2-digit', minute: '2-digit' })

export function canUndo(action: AgentAction) {
  return action.mutations.some(
    ({ status, undo }) =>
      (status === 'applied' || status === 'partial') && (!undo || undo.status === 'failed'),
  )
}

function threadName(identity: ThreadIdentity | undefined) {
  return identity ? identity.subject.trim() || '(No subject)' : 'Thread unavailable'
}

function eventNotices(action: AgentAction) {
  const notices: string[] = []
  const undoConflicted = action.mutations.some(({ undo }) => undo?.superseded?.length)
  if (action.currentDraftMirrorFailed)
    notices.push('Draft saved in AMC. Sync to Account Drafts will retry.')
  if (undoConflicted) notices.push('Newer Gmail changes preserved')
  if (action.mutations.some(({ undo }) => undo?.status === 'failed')) notices.push('Undo failed')
  if (action.mutations.some(({ undo }) => undo?.status === 'partial'))
    notices.push('Undo partially applied')
  if (action.mutations.some(({ undo }) => undo?.status === 'pending')) notices.push('Undo pending')
  if (
    !undoConflicted &&
    action.mutations.some(({ undo }) => undo?.status === 'applied') &&
    !action.mutations.some(({ undo }) => undo && undo.status !== 'applied')
  ) {
    notices.push(canUndo(action) ? 'Some changes undone' : 'Undone')
  }
  return notices
}

function EventDetails({
  action,
  identities,
  timestamp,
  runId,
}: {
  action: AgentAction
  identities: ReadonlyMap<string, ThreadIdentity>
  timestamp: string
  runId: string | null
}) {
  return (
    <div className="grid gap-4 rounded-md border bg-muted/40 p-4 text-xs leading-relaxed">
      <dl className="grid grid-cols-[5.75rem_minmax(0,1fr)] gap-x-3 gap-y-1.5">
        <dt className="text-muted-foreground">Timestamp</dt>
        <dd className="font-mono">{timestamp}</dd>
        <dt className="text-muted-foreground">Actor</dt>
        <dd className="wrap-anywhere">{action.tokenName}</dd>
        {runId && (
          <>
            <dt className="text-muted-foreground">Run ID</dt>
            <dd className="font-mono wrap-anywhere">{runId}</dd>
          </>
        )}
        <dt className="text-muted-foreground">Action ID</dt>
        <dd className="font-mono wrap-anywhere">{action.id}</dd>
        <dt className="text-muted-foreground">Tool</dt>
        <dd className="font-mono wrap-anywhere">{action.tool}</dd>
        {action.draftId && (
          <>
            <dt className="text-muted-foreground">Draft ID</dt>
            <dd className="font-mono wrap-anywhere">{action.draftId}</dd>
          </>
        )}
      </dl>
      {action.error && <p className="wrap-anywhere text-destructive">{action.error}</p>}
      {action.currentDraftMirrorFailed && (
        <p>Current draft is saved in AMC. Sync to the Account’s Drafts failed and will retry.</p>
      )}
      {action.threads.length > 0 && (
        <ul className="grid gap-3 border-t pt-3" aria-label="Thread diagnostics">
          {action.threads.map((id) => {
            const identity = identities.get(id)
            const mutation = action.mutations.find(({ threadId }) => threadId === id)
            const undo = mutation?.undo
            return (
              <li key={id} className="grid gap-0.5 wrap-anywhere">
                <span className="font-medium">
                  {threadName(identity)}
                  {identity?.sender && (
                    <span className="font-normal text-muted-foreground"> · {identity.sender}</span>
                  )}
                </span>
                <span className="font-mono text-muted-foreground">Thread ID {id}</span>
                {mutation && (
                  <p>
                    {outcomes[mutation.status].label}
                    {mutation.error && (
                      <span className="text-destructive"> · {mutation.error}</span>
                    )}
                  </p>
                )}
                {undo && (
                  <p>
                    {undo.status === 'applied' && undo.superseded?.length
                      ? 'Undo preserved newer Gmail changes'
                      : `Undo ${outcomes[undo.status].label.toLowerCase()}`}
                    {undo.error && <span className="text-destructive"> · {undo.error}</span>}
                    {undo.status !== 'applied' &&
                      !!undo.superseded?.length &&
                      ' · Newer Gmail changes preserved'}
                  </p>
                )}
              </li>
            )
          })}
        </ul>
      )}
    </div>
  )
}

export const ActivityEvent = memo(function ActivityEvent({
  action,
  identities,
  undoBlocked,
  onUndo,
}: {
  action: AgentAction
  identities: ReadonlyMap<string, ThreadIdentity>
  undoBlocked: boolean
  onUndo: (id: string) => void
}) {
  const [expanded, setExpanded] = useState(false)
  const detailsId = useId()
  const timestamp = new Date(action.createdAt).toISOString()
  const name = Object.hasOwn(operationNames, action.tool)
    ? operationNames[action.tool]
    : 'Agent action'
  const outcome = outcomes[action.status]
  const StatusIcon = outcome.icon
  const runSuffix = action.tokenName.startsWith('triage-') ? action.tokenName.slice(7) : null
  const runId = isCorrelationId(runSuffix) ? runSuffix : null
  const actor = runId ? 'Automated triage' : action.tokenName || 'Agent'
  const singleIdentity = action.threads.length === 1 ? identities.get(action.threads[0]) : undefined
  const target =
    action.threads.length > 1
      ? `${action.threads.length} Threads`
      : action.threads.length === 1
        ? threadName(singleIdentity)
        : action.tool === 'create_draft'
          ? 'Standalone draft'
          : 'No Thread recorded'
  const attribution = [actor, singleIdentity?.sender].filter(Boolean).join(' · ')
  const notices = eventNotices(action)

  return (
    <li className="grid grid-cols-[3.75rem_minmax(0,1fr)_8.5rem_9.25rem] items-start gap-x-2.5 px-5 py-3">
      <time
        dateTime={timestamp}
        className="pt-0.5 text-xs leading-5 text-muted-foreground tabular-nums"
      >
        {timeFormat.format(action.createdAt)}
      </time>
      <div className="grid min-w-0 gap-0.5">
        <h4 id={`${detailsId}-title`} className="truncate text-sm leading-5 font-semibold">
          {name}
        </h4>
        <p className="truncate text-sm leading-5" title={target}>
          {target}
        </p>
        <p className="truncate text-xs leading-4 text-muted-foreground" title={attribution}>
          {attribution}
        </p>
      </div>
      <span
        className={cn(
          'inline-flex w-fit items-center gap-1.5 rounded-full px-2 py-0.5 text-xs font-medium whitespace-nowrap',
          outcome.style,
        )}
      >
        <StatusIcon className="size-3" aria-hidden />
        {outcome.label}
      </span>
      <div className="-mt-2 flex justify-end gap-0.5">
        {canUndo(action) && (
          <Button
            type="button"
            variant="ghost"
            size="sm"
            className="h-9 px-2 text-primary aria-disabled:opacity-50"
            aria-describedby={`${detailsId}-title`}
            aria-disabled={undoBlocked}
            onClick={() => {
              if (!undoBlocked) onUndo(action.id)
            }}
          >
            <Undo2 className="size-3.5" aria-hidden />
            Undo
          </Button>
        )}
        <Button
          type="button"
          variant="ghost"
          size="sm"
          className="group h-9 px-2 text-muted-foreground"
          aria-describedby={`${detailsId}-title`}
          aria-expanded={expanded}
          aria-controls={detailsId}
          onClick={() => setExpanded(!expanded)}
        >
          <ChevronRight className="size-3.5 group-aria-expanded:rotate-90" aria-hidden />
          Details
        </Button>
      </div>
      {notices.length > 0 && (
        <p className="col-span-3 col-start-2 mt-1.5 flex items-start gap-1.5 text-xs leading-5 text-muted-foreground">
          <CircleAlert className="mt-0.5 size-3.5 shrink-0" aria-hidden />
          {notices.join(' · ')}
        </p>
      )}
      <div id={detailsId} className="col-span-3 col-start-2 mt-3" hidden={!expanded}>
        {expanded && (
          <EventDetails
            action={action}
            identities={identities}
            timestamp={timestamp}
            runId={runId}
          />
        )}
      </div>
    </li>
  )
})
