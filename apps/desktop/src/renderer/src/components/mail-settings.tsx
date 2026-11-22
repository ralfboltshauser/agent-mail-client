import { useEffect, useId, useState } from 'react'
import { toast } from 'sonner'
import { setLoadRemoteImagesAutomatically, useRemoteImages } from '@/data/remote-image-preferences'
import { getAmc } from '@/lib/amc'
import type { NotificationSettings } from '../../../shared/api'
import { AutoTriageSetting } from './triage-status'
import { Button } from './ui/button'
import { Dialog, DialogContent, DialogDescription, DialogHeader, DialogTitle } from './ui/dialog'
import { Input } from './ui/input'

export function MailSettings({
  initial,
  onClose,
  onCloseAutoFocus,
}: {
  initial: number
  onClose: () => void
  onCloseAutoFocus: (event: Event) => void
}) {
  const id = useId()
  const [seconds, setSeconds] = useState(String(initial))
  const [saving, setSaving] = useState(false)
  return (
    <Dialog
      open
      onOpenChange={(open) => {
        if (!open) onClose()
      }}
    >
      <DialogContent
        onCloseAutoFocus={onCloseAutoFocus}
        className="max-h-[calc(100dvh-2rem)] overflow-y-auto sm:max-w-sm"
      >
        <DialogHeader>
          <DialogTitle>Settings</DialogTitle>
          <DialogDescription>Manage mail preferences and Mac notifications.</DialogDescription>
        </DialogHeader>
        <form
          className="grid gap-4"
          onSubmit={(event) => {
            event.preventDefault()
            if (saving) return
            setSaving(true)
            void getAmc()
              .saveSendSettings(Number(seconds))
              .then(() => {
                toast.success('Undo send settings saved')
              })
              .catch((cause: Error) => {
                toast.error('Could not save settings', { description: cause.message })
              })
              .finally(() => setSaving(false))
          }}
        >
          <fieldset className="grid gap-2">
            <legend className="mb-2 text-sm font-medium">Undo send</legend>
            <p className="text-sm text-muted-foreground">
              Hold outgoing mail briefly so you can bring it back to Drafts.
            </p>
            <label htmlFor={id} className="grid gap-2 text-sm">
              Delay in seconds
              <Input
                id={id}
                type="number"
                min={0}
                max={120}
                value={seconds}
                onChange={(event) => setSeconds(event.target.value)}
                disabled={saving}
                required
              />
            </label>
          </fieldset>
          <Button variant="outline" className="justify-self-end" type="submit" disabled={saving}>
            {saving ? 'Saving…' : 'Save undo send'}
          </Button>
        </form>
        <div className="border-t pt-4">
          <AutoTriageSetting />
        </div>
        <PrivacyPreferences />
        <NotificationPreferences />
      </DialogContent>
    </Dialog>
  )
}

function PrivacyPreferences() {
  const id = useId()
  const automatic = useRemoteImages()
  return (
    <section aria-label="Privacy" className="grid gap-2 border-t pt-4">
      <h3 className="text-sm font-medium">Privacy</h3>
      <label className="flex items-center gap-2 text-sm">
        <input
          type="checkbox"
          checked={automatic}
          aria-describedby={id}
          onChange={(event) => setLoadRemoteImagesAutomatically(event.target.checked)}
        />
        Load remote images automatically
      </label>
      <p id={id} className="text-xs text-muted-foreground">
        Remote images can tell senders when you opened their mail.
      </p>
    </section>
  )
}

function NotificationPreferences() {
  const startId = useId()
  const endId = useId()
  const [settings, setSettings] = useState<NotificationSettings>()
  const [saving, setSaving] = useState(false)
  const [loadError, setLoadError] = useState<string>()
  useEffect(() => {
    void getAmc()
      .notificationSettings()
      .then(setSettings)
      .catch((error: Error) => {
        setLoadError(error.message)
      })
  }, [])

  if (!settings) {
    return (
      <output className="border-t pt-4 text-sm text-muted-foreground">
        {loadError
          ? `Could not load notification settings. ${loadError}`
          : 'Loading notifications…'}
      </output>
    )
  }
  return (
    <form
      className="flex flex-col gap-4 border-t pt-4"
      onSubmit={(event) => {
        event.preventDefault()
        if (saving) return
        setSaving(true)
        void getAmc()
          .saveNotificationSettings(settings)
          .then(() => toast.success('Notification settings saved'))
          .catch((error: Error) => {
            toast.error('Could not save notifications', { description: error.message })
          })
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
          Show subject and snippet
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
            Use local time. Leave both fields blank to disable quiet hours.
          </p>
        </fieldset>
      </fieldset>
      <Button className="self-end" type="submit" disabled={saving}>
        {saving ? 'Saving…' : 'Save notifications'}
      </Button>
    </form>
  )
}
