import type { AgentAction } from '@amc/protocol'
import { Activity } from 'lucide-react'
import { useState } from 'react'
import { Button } from '@/components/ui/button'
import {
  Dialog,
  DialogContent,
  DialogDescription,
  DialogHeader,
  DialogTitle,
  DialogTrigger,
} from '@/components/ui/dialog'
import { SidebarMenu, SidebarMenuButton, SidebarMenuItem } from '@/components/ui/sidebar'

export function AgentActivity() {
  const [actions, setActions] = useState<AgentAction[]>([])
  const [cursor, setCursor] = useState<number>()
  const [next, setNext] = useState<number | null>(null)
  const [busy, setBusy] = useState(false)
  const [error, setError] = useState<string | null>(null)

  async function load(before?: number, undoId?: string) {
    setBusy(true)
    setError(null)
    try {
      if (undoId) await window.amc.undoAgentAction(undoId)
      const page = await window.amc.agentActivity(before)
      setActions(page.actions)
      setCursor(before)
      setNext(page.nextBefore)
    } catch (cause) {
      setError(cause instanceof Error ? cause.message : 'Could not load Agent activity')
    } finally {
      setBusy(false)
    }
  }

  return (
    <Dialog
      onOpenChange={(open) => {
        if (open) void load()
      }}
    >
      <SidebarMenu>
        <SidebarMenuItem>
          <DialogTrigger asChild>
            <SidebarMenuButton tooltip="Agent activity">
              <Activity aria-hidden="true" />
              <span>Agent activity</span>
            </SidebarMenuButton>
          </DialogTrigger>
        </SidebarMenuItem>
      </SidebarMenu>
      <DialogContent className="sm:max-w-xl">
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
          {busy && <output className="self-center text-sm text-muted-foreground">Loading…</output>}
        </div>
        {error && (
          <p role="alert" className="text-sm text-destructive">
            {error}
          </p>
        )}
        {!actions.length && !busy && !error && (
          <p className="text-sm text-muted-foreground">No Agent actions yet.</p>
        )}
        <ul className="max-h-[50vh] divide-y overflow-y-auto" aria-busy={busy}>
          {actions.map((action) => (
            <li key={action.id} className="flex items-start justify-between gap-3 py-3 text-sm">
              <div className="min-w-0 space-y-1">
                <div className="font-medium wrap-anywhere">
                  {action.tokenName} · {action.tool.replaceAll('_', ' ')}
                </div>
                <div className="text-muted-foreground">
                  {new Date(action.createdAt).toLocaleString()} · {action.status}
                </div>
                {action.error && <div className="text-destructive">{action.error}</div>}
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
