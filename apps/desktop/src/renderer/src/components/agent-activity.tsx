import type { AgentAction } from '@amc/protocol'
import { Activity, CircleAlert } from 'lucide-react'
import { useCallback, useEffect, useState } from 'react'
import { Button } from '@/components/ui/button'
import {
  Dialog,
  DialogContent,
  DialogDescription,
  DialogHeader,
  DialogTitle,
} from '@/components/ui/dialog'
import { getAmc } from '@/lib/amc'
import { MailLoading, MailState } from './mail-state'
import { Badge } from './ui/badge'

export function AgentActivity({
  open,
  onOpenChange,
  onCloseAutoFocus,
}: {
  open: boolean
  onOpenChange: (open: boolean) => void
  onCloseAutoFocus: (event: Event) => void
}) {
  const [actions, setActions] = useState<AgentAction[]>([])
  const [cursor, setCursor] = useState<number>()
  const [next, setNext] = useState<number | null>(null)
  const [busy, setBusy] = useState(false)
  const [error, setError] = useState<string | null>(null)

  const load = useCallback(async (before?: number, undoId?: string) => {
    setBusy(true)
    setError(null)
    try {
      if (undoId) await getAmc().undoAgentAction(undoId)
      const page = await getAmc().agentActivity(before)
      setActions(page.actions)
      setCursor(before)
      setNext(page.nextBefore)
    } catch (cause) {
      setError(cause instanceof Error ? cause.message : 'Could not load Agent activity')
    } finally {
      setBusy(false)
    }
  }, [])

  useEffect(() => {
    if (open) void load()
  }, [open, load])

  return (
    <Dialog open={open} onOpenChange={onOpenChange}>
      <DialogContent onCloseAutoFocus={onCloseAutoFocus} className="sm:max-w-xl">
        <DialogHeader>
          <DialogTitle>Agent activity</DialogTitle>
          <DialogDescription>Review Agent writes and undo organize actions.</DialogDescription>
        </DialogHeader>
        <div className="flex flex-wrap gap-2">
          <Button variant="outline" size="sm" disabled={busy} onClick={() => void load(cursor)}>
            Refresh
          </Button>
          {cursor !== undefined && (
            <Button variant="ghost" size="sm" disabled={busy} onClick={() => void load()}>
              Newest
            </Button>
          )}
          {next !== null && (
            <Button variant="ghost" size="sm" disabled={busy} onClick={() => void load(next)}>
              Older
            </Button>
          )}
        </div>
        {error && (
          <MailState icon={CircleAlert} title="Could not load Agent activity" error>
            {error}
          </MailState>
        )}
        {!actions.length && !busy && !error && (
          <MailState icon={Activity} title="No Agent activity yet">
            Actions the Agent takes on your mail will appear here.
          </MailState>
        )}
        {busy && !actions.length && <MailLoading label="Loading Agent activity" />}
        <ul className="max-h-[50vh] divide-y overflow-y-auto" aria-busy={busy}>
          {actions.map((action) => (
            <li key={action.id} className="flex items-start justify-between gap-3 py-3 text-sm">
              <div className="min-w-0 space-y-1">
                <div className="font-medium wrap-anywhere">
                  {action.tokenName} · {action.tool.replaceAll('_', ' ')}
                </div>
                <div className="text-muted-foreground">
                  {new Date(action.createdAt).toLocaleString()}{' '}
                  <Badge variant="secondary" className="ml-1 capitalize">
                    {action.status}
                  </Badge>
                </div>
                {action.error && <div className="text-destructive">{action.error}</div>}
                {action.currentDraftMirrorFailed && (
                  <div className="text-muted-foreground">
                    Current draft is saved in AMC. Sync to the Account’s Drafts failed and will
                    retry.
                  </div>
                )}
                {action.threads.map((thread) => {
                  const mutation = action.mutations.find((result) => result.threadId === thread)
                  const undoConflict = mutation?.undo?.superseded?.length
                  return (
                    <div key={thread} className="wrap-anywhere text-muted-foreground">
                      {thread}
                      {mutation && ` · ${mutation.status}`}
                      {mutation?.error && ` · ${mutation.error}`}
                      {mutation?.undo && ` · Undo ${mutation.undo.status}`}
                      {mutation?.undo?.error && ` · ${mutation.undo.error}`}
                      {!!undoConflict && ' · Newer Gmail changes preserved'}
                    </div>
                  )
                })}
              </div>
              {action.mutations.some(
                ({ status, undo }) =>
                  (status === 'applied' || status === 'partial') &&
                  (!undo || undo.status === 'failed'),
              ) && (
                <Button
                  variant="outline"
                  size="sm"
                  disabled={busy}
                  onClick={() => void load(cursor, action.id)}
                >
                  Undo
                </Button>
              )}
            </li>
          ))}
        </ul>
      </DialogContent>
    </Dialog>
  )
}
