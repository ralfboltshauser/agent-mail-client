import {
  type Draft,
  type OutboxItem,
  SEND_ACCOUNT_UNAVAILABLE,
  SEND_NEEDS_SIGN_IN,
} from '@amc/protocol'
import { CircleAlert, FileText, SendHorizontal, Settings2, Trash2 } from 'lucide-react'
import { useEffect, useState } from 'react'
import { toast } from 'sonner'
import { getAmc } from '@/lib/amc'
import { DiscardDraftDialog } from './discard-draft-dialog'
import { MailLoading, MailState } from './mail-state'
import { Button } from './ui/button'
import { Dialog, DialogContent, DialogTitle } from './ui/dialog'

const statusText: Record<OutboxItem['status'], string> = {
  queued: 'Scheduled',
  dispatching: 'Checking delivery',
  sent: 'Sent',
  cancelled: 'Cancelled',
  uncertain: 'May have been sent',
  failed: 'Rejected',
}

function usePolling<T>(load: () => Promise<T>, interval: number) {
  const [data, setData] = useState<T>()
  const [error, setError] = useState('')
  useEffect(() => {
    let mounted = true
    let loading = false
    const refresh = async () => {
      if (loading) return
      loading = true
      try {
        const result = await load()
        if (mounted) {
          setData(result)
          setError('')
        }
      } catch (cause) {
        if (mounted) setError((cause as Error).message)
      } finally {
        loading = false
      }
    }
    void refresh()
    const timer = window.setInterval(() => void refresh(), interval)
    return () => {
      mounted = false
      window.clearInterval(timer)
    }
  }, [load, interval])
  return { data, error }
}

const loadDrafts = () => getAmc().composeDrafts()
const loadOutbox = () => getAmc().outbox()

function MailboxHeader({ title, children }: { title: string; children?: React.ReactNode }) {
  return (
    <header className="app-drag app-toolbar justify-between px-5">
      <h2 className="text-[15px] font-semibold tracking-tight">{title}</h2>
      {children}
    </header>
  )
}

export function DraftsView({
  accountId,
  onOpen,
  onDiscarded,
}: {
  accountId: string | null
  onOpen: (id: string) => void
  onDiscarded: (id: string) => void
}) {
  const { data, error } = usePolling<Draft[]>(loadDrafts, 1500)
  const [discardId, setDiscardId] = useState<string | null>(null)
  const [discarded, setDiscarded] = useState<string[]>([])
  const drafts = data?.filter(
    (draft) => (!accountId || draft.accountId === accountId) && !discarded.includes(draft.id),
  )
  return (
    <section className="flex h-full flex-col">
      <MailboxHeader title="Drafts" />
      <div className="min-h-0 flex-1 overflow-auto">
        {error && (
          <MailState icon={CircleAlert} title="Could not load drafts" error>
            {error}
          </MailState>
        )}
        {!data && !error && <MailLoading label="Loading drafts" />}
        {!error && drafts?.length === 0 && (
          <MailState icon={FileText} title="No saved drafts">
            Messages you start writing appear here.
          </MailState>
        )}
        {drafts?.map((draft) => (
          <div key={draft.id} className="flex items-center border-b pr-3 hover:bg-accent">
            <button
              type="button"
              onClick={() => onOpen(draft.id)}
              className="flex min-w-0 flex-1 items-center justify-between gap-4 px-4 py-3 text-left focus-visible:outline-ring"
            >
              <span className="min-w-0">
                <span className="block truncate text-sm font-medium">
                  {draft.subject || '(No subject)'}
                </span>
                <span className="block truncate text-xs text-muted-foreground">
                  {draft.to.map((r) => r.name || r.address).join(', ') || draft.from}
                </span>
              </span>
              <time className="shrink-0 text-xs text-muted-foreground">
                {new Date(draft.updatedAt).toLocaleDateString()}
              </time>
            </button>
            <Button
              size="icon-sm"
              variant="ghost"
              aria-label={`Discard draft: ${draft.subject || '(No subject)'}`}
              title="Discard draft"
              onClick={() => setDiscardId(draft.id)}
            >
              <Trash2 />
            </Button>
          </div>
        ))}
      </div>
      {discardId && (
        <DiscardDraftDialog
          onClose={() => setDiscardId(null)}
          onConfirm={async () => {
            const { warning } = await getAmc().discardDraft(discardId)
            setDiscarded((ids) => [...ids, discardId])
            onDiscarded(discardId)
            if (warning) toast.warning(warning)
          }}
        />
      )}
    </section>
  )
}

export function OutboxView({
  accountId,
  onRestore,
  onThread,
  onSettings,
}: {
  accountId: string | null
  onRestore: (id: string) => void
  onThread: (id: string) => void
  onSettings: () => void
}) {
  const { data, error } = usePolling<OutboxItem[]>(loadOutbox, 750)
  const [confirm, setConfirm] = useState<OutboxItem | null>(null)
  const items = data?.filter((item) => !accountId || item.accountId === accountId)
  return (
    <section className="flex h-full flex-col">
      <MailboxHeader title="Outbox">
        <Button variant="ghost" size="icon-sm" aria-label="Settings" onClick={onSettings}>
          <Settings2 />
        </Button>
      </MailboxHeader>
      <div className="min-h-0 flex-1 overflow-auto">
        {error && (
          <MailState icon={CircleAlert} title="Could not load Outbox" error>
            {error}
          </MailState>
        )}
        {!data && !error && <MailLoading label="Loading Outbox" />}
        {!error && items?.length === 0 && (
          <MailState icon={SendHorizontal} title="Outbox is clear">
            Scheduled and recent sends appear here.
          </MailState>
        )}
        {items?.map((item) => {
          const threadId = item.threadId
          return (
            <article
              key={item.id}
              className="flex flex-wrap items-start justify-between gap-3 border-b px-5 py-4"
            >
              <div className="min-w-0">
                <h3 className="truncate text-sm font-medium">{item.subject || '(No subject)'}</h3>
                <p className="truncate text-xs text-muted-foreground">
                  {item.to.map((r) => r.name || r.address).join(', ')}
                </p>
                <p className="mt-1 text-xs">
                  {item.status === 'queued'
                    ? item.sendAt <= Date.now()
                      ? 'Waiting for delivery'
                      : `Scheduled · ${new Date(item.sendAt).toLocaleString()}`
                    : item.detail === SEND_ACCOUNT_UNAVAILABLE
                      ? SEND_NEEDS_SIGN_IN
                      : statusText[item.status]}
                </p>
                {item.detail && (
                  <p className="mt-1 max-w-prose text-xs text-muted-foreground">{item.detail}</p>
                )}
                {item.status === 'uncertain' && (
                  <p className="mt-1 break-all font-mono text-xs text-muted-foreground">
                    {item.messageId}
                  </p>
                )}
              </div>
              {item.status === 'queued' && (
                <Button
                  size="sm"
                  variant="outline"
                  onClick={() => {
                    void getAmc()
                      .cancelSend(item.id)
                      .then(() => onRestore(item.draftId))
                      .catch((cause: Error) => toast.error(cause.message))
                  }}
                >
                  {item.sendAt > item.undoUntil ? 'Cancel and reopen to reschedule' : 'Cancel send'}
                </Button>
              )}
              {item.canResolve && (
                <div className="flex gap-2">
                  <Button
                    size="sm"
                    variant="outline"
                    onClick={() => {
                      void getAmc()
                        .resolveSend(item.id, 'check')
                        .then(() => toast.info('Checking Sent for this message'))
                        .catch((cause: Error) => toast.error(cause.message))
                    }}
                  >
                    Check Sent again
                  </Button>
                  <Button size="sm" variant="ghost" onClick={() => setConfirm(item)}>
                    Reopen draft…
                  </Button>
                </div>
              )}
              {item.status === 'failed' && (
                <Button size="sm" variant="outline" onClick={() => onRestore(item.draftId)}>
                  Open draft
                </Button>
              )}
              {item.status === 'sent' && threadId && (
                <Button size="sm" variant="ghost" onClick={() => onThread(threadId)}>
                  View Thread
                </Button>
              )}
            </article>
          )
        })}
      </div>
      {confirm && (
        <Dialog
          open
          onOpenChange={(open) => {
            if (!open) setConfirm(null)
          }}
        >
          <DialogContent>
            <DialogTitle>Reopen this draft?</DialogTitle>
            <p className="text-sm text-muted-foreground">
              The original message may have reached its recipients. Check Sent before deciding
              whether to send a new copy.
            </p>
            <Button
              className="justify-self-end"
              onClick={() => {
                void getAmc()
                  .resolveSend(confirm.id, 'reopen')
                  .then(({ draftId }) => {
                    setConfirm(null)
                    onRestore(draftId)
                  })
                  .catch((cause: Error) => toast.error(cause.message))
              }}
            >
              Reopen draft
            </Button>
          </DialogContent>
        </Dialog>
      )}
    </section>
  )
}
