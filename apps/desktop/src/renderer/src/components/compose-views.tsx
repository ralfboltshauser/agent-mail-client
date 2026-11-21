import {
  type Draft,
  type OutboxItem,
  SEND_ACCOUNT_UNAVAILABLE,
  SEND_NEEDS_SIGN_IN,
} from '@amc/protocol'
import { Settings2 } from 'lucide-react'
import { useEffect, useId, useState } from 'react'
import { toast } from 'sonner'
import type { NotificationSettings } from '../../../shared/api'
import { Button } from './ui/button'
import { Dialog, DialogContent, DialogTitle } from './ui/dialog'
import { Input } from './ui/input'

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

const loadDrafts = () => window.amc.composeDrafts()
const loadOutbox = () => window.amc.outbox()

function MailboxHeader({ title, children }: { title: string; children?: React.ReactNode }) {
  return (
    <header className="app-drag flex h-12 shrink-0 items-center justify-between gap-2 border-b px-4">
      <h2 className="text-sm font-semibold">{title}</h2>
      {children}
    </header>
  )
}

export function DraftsView({
  accountId,
  onOpen,
}: {
  accountId: string | null
  onOpen: (id: string) => void
}) {
  const { data, error } = usePolling<Draft[]>(loadDrafts, 1500)
  const drafts = data?.filter((draft) => !accountId || draft.accountId === accountId)
  return (
    <section className="flex h-full flex-col">
      <MailboxHeader title="Drafts" />
      <div className="min-h-0 overflow-auto">
        {error && (
          <p role="alert" className="p-4 text-sm text-destructive">
            {error}
          </p>
        )}
        {!error && drafts?.length === 0 && (
          <p className="p-4 text-sm text-muted-foreground">No saved drafts.</p>
        )}
        {drafts?.map((draft) => (
          <button
            type="button"
            key={draft.id}
            onClick={() => onOpen(draft.id)}
            className="flex w-full items-center justify-between gap-4 border-b px-4 py-3 text-left hover:bg-accent focus-visible:outline-ring"
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
        ))}
      </div>
    </section>
  )
}

export function OutboxView({
  accountId,
  onRestore,
  onThread,
}: {
  accountId: string | null
  onRestore: (id: string) => void
  onThread: (id: string) => void
}) {
  const { data, error } = usePolling<OutboxItem[]>(loadOutbox, 750)
  const [confirm, setConfirm] = useState<OutboxItem | null>(null)
  const settingsId = useId()
  const [settings, setSettings] = useState<number | null>(null)
  const [settingsOpen, setSettingsOpen] = useState(false)
  const items = data?.filter((item) => !accountId || item.accountId === accountId)
  return (
    <section className="flex h-full flex-col">
      <MailboxHeader title="Outbox">
        <Button
          variant="ghost"
          size="icon-sm"
          aria-label="Settings"
          onClick={() => {
            setSettings(null)
            setSettingsOpen(true)
            void window.amc
              .sendSettings()
              .then(({ undoSendSeconds }) => setSettings(undoSendSeconds))
              .catch((cause: Error) => toast.error(cause.message))
          }}
        >
          <Settings2 />
        </Button>
      </MailboxHeader>
      <div className="min-h-0 overflow-auto">
        {error && (
          <p role="alert" className="p-4 text-sm text-destructive">
            {error}
          </p>
        )}
        {!error && items?.length === 0 && (
          <p className="p-4 text-sm text-muted-foreground">
            Scheduled and recent sends appear here.
          </p>
        )}
        {items?.map((item) => {
          const threadId = item.threadId
          return (
            <article
              key={item.id}
              className="flex flex-wrap items-start justify-between gap-3 border-b px-4 py-3"
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
                    void window.amc
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
                      void window.amc
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
                void window.amc
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
      {settingsOpen && (
        <Dialog open onOpenChange={setSettingsOpen}>
          <DialogContent aria-describedby={undefined}>
            <DialogTitle>Settings</DialogTitle>
            {settings !== null && (
              <form
                className="flex flex-col gap-4"
                onSubmit={(event) => {
                  event.preventDefault()
                  void window.amc
                    .saveSendSettings(settings)
                    .then(() => setSettingsOpen(false))
                    .catch((cause: Error) => toast.error(cause.message))
                }}
              >
                <label htmlFor={settingsId} className="flex flex-col gap-2 text-sm">
                  Seconds to hold mail before sending
                  <Input
                    type="number"
                    min={0}
                    max={120}
                    value={settings}
                    onChange={(event) => setSettings(Number(event.target.value))}
                    required
                  />
                </label>
                <Button className="self-end" type="submit">
                  Save undo send
                </Button>
              </form>
            )}
            <NotificationPreferences />
          </DialogContent>
        </Dialog>
      )}
    </section>
  )
}

function NotificationPreferences() {
  const startId = useId()
  const endId = useId()
  const [settings, setSettings] = useState<NotificationSettings>()
  const [saving, setSaving] = useState(false)
  useEffect(() => {
    void window.amc
      .notificationSettings()
      .then(setSettings)
      .catch((error: Error) => {
        toast.error(error.message)
      })
  }, [])

  if (!settings) return null
  return (
    <form
      className="flex flex-col gap-4 border-t pt-4"
      onSubmit={(event) => {
        event.preventDefault()
        setSaving(true)
        void window.amc
          .saveNotificationSettings(settings)
          .then(() => toast.success('Notification settings saved'))
          .catch((error: Error) => toast.error(error.message))
          .finally(() => setSaving(false))
      }}
    >
      <fieldset className="flex flex-col gap-3 text-sm" disabled={saving}>
        <legend className="mb-2 font-medium">Mac notifications</legend>
        <label className="flex items-center gap-2">
          <input
            type="checkbox"
            checked={settings.enabled}
            onChange={(event) => setSettings({ ...settings, enabled: event.target.checked })}
          />
          Notify for new mail
        </label>
        <label className="flex items-center gap-2">
          <input
            type="checkbox"
            checked={settings.showSnippet}
            onChange={(event) => setSettings({ ...settings, showSnippet: event.target.checked })}
          />
          Show message snippet
        </label>
        <fieldset>
          <legend className="mb-2">Quiet hours</legend>
          <div className="flex gap-3">
            <label htmlFor={startId} className="flex min-w-0 flex-1 flex-col gap-1">
              Start
              <Input
                id={startId}
                type="time"
                value={settings.quietStart}
                onChange={(event) => setSettings({ ...settings, quietStart: event.target.value })}
              />
            </label>
            <label htmlFor={endId} className="flex min-w-0 flex-1 flex-col gap-1">
              End
              <Input
                id={endId}
                type="time"
                value={settings.quietEnd}
                onChange={(event) => setSettings({ ...settings, quietEnd: event.target.value })}
              />
            </label>
          </div>
          <p className="mt-2 text-xs text-muted-foreground">
            Leave both times blank to disable quiet hours.
          </p>
        </fieldset>
      </fieldset>
      <Button className="self-end" type="submit" disabled={saving}>
        {saving ? 'Saving…' : 'Save notifications'}
      </Button>
    </form>
  )
}
