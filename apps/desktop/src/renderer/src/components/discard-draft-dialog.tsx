import { useRef, useState } from 'react'
import { toast } from 'sonner'
import { Button } from './ui/button'
import { Dialog, DialogContent, DialogDescription, DialogFooter, DialogTitle } from './ui/dialog'

export function DiscardDraftDialog({
  onConfirm,
  onClose,
}: {
  onConfirm: () => Promise<void>
  onClose: () => void
}) {
  const [pending, setPending] = useState(false)
  const submitting = useRef(false)
  const confirm = async () => {
    if (submitting.current) return
    submitting.current = true
    setPending(true)
    try {
      await onConfirm()
      onClose()
    } catch (cause) {
      toast.error((cause as Error).message)
    } finally {
      submitting.current = false
      setPending(false)
    }
  }
  return (
    <Dialog
      open
      onOpenChange={(open) => {
        if (!open && !submitting.current) onClose()
      }}
    >
      <DialogContent showCloseButton={false}>
        <DialogTitle>Discard draft?</DialogTitle>
        <DialogDescription>The draft will be deleted from AMC.</DialogDescription>
        <DialogFooter>
          <Button variant="outline" disabled={pending} onClick={onClose}>
            Cancel
          </Button>
          <Button variant="destructive" disabled={pending} onClick={() => void confirm()}>
            Discard draft
          </Button>
        </DialogFooter>
      </DialogContent>
    </Dialog>
  )
}
