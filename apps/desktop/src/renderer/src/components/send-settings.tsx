import { useId, useState } from 'react'
import { toast } from 'sonner'
import { getAmc } from '@/lib/amc'
import { AutoTriageSetting } from './triage-status'
import { Button } from './ui/button'
import { Dialog, DialogContent, DialogDescription, DialogHeader, DialogTitle } from './ui/dialog'
import { Input } from './ui/input'

export function SendSettings({
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
      <DialogContent onCloseAutoFocus={onCloseAutoFocus} className="sm:max-w-sm">
        <DialogHeader>
          <DialogTitle>Settings</DialogTitle>
          <DialogDescription>
            Hold outgoing mail briefly so you can bring it back to Drafts.
          </DialogDescription>
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
                onClose()
              })
              .catch((cause: Error) => {
                toast.error('Could not save settings', { description: cause.message })
              })
              .finally(() => setSaving(false))
          }}
        >
          <label htmlFor={id} className="grid gap-2 text-sm">
            Delay in seconds
            <Input
              id={id}
              type="number"
              min={0}
              max={120}
              value={seconds}
              onChange={(event) => setSeconds(event.target.value)}
              required
            />
          </label>
          <Button className="justify-self-end" type="submit" disabled={saving}>
            Save settings
          </Button>
        </form>
        <AutoTriageSetting />
      </DialogContent>
    </Dialog>
  )
}
