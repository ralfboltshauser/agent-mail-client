import type { DiscardDraftResult } from '@amc/protocol'
import { useRef, useState } from 'react'
import { toast } from 'sonner'
import { failureText } from '@/lib/failure'
import { Button } from './ui/button'
import { Dialog, DialogContent, DialogDescription, DialogFooter, DialogTitle } from './ui/dialog'

export function DiscardDraftDialog({
  subject,
  onConfirm,
  onClose,
  onCloseAutoFocus,
}: {
  subject: string
  onConfirm: () => Promise<DiscardDraftResult>
  onClose: () => void
  onCloseAutoFocus?: (event: Event) => void
}) {
  const [pending, setPending] = useState(false)
  const submitting = useRef(false)
  const confirm = async () => {
    if (submitting.current) return
    submitting.current = true
    setPending(true)
    try {
      const result = await onConfirm()
      if ('absent' in result) {
        toast.info('This draft is already gone. It may have been sent or discarded elsewhere.')
      } else {
        const message = result.providerRemoved
          ? `Draft discarded. The matching copy is gone from ${result.providerRemoved}.`
          : 'Draft discarded'
        if (result.warning) toast.warning(message, { description: result.warning })
        else toast.success(message)
      }
      onClose()
    } catch (cause) {
      toast.error('Could not discard draft', { description: failureText(cause) })
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
      <DialogContent showCloseButton={false} onCloseAutoFocus={onCloseAutoFocus}>
        <DialogTitle>Discard draft?</DialogTitle>
        <DialogDescription className="wrap-anywhere">
          “{subject || '(No subject)'}” will be deleted from AMC. A matching copy that AMC wrote in
          Gmail or IMAP will also be permanently deleted. An unchanged draft imported from IMAP can
          also be permanently deleted.
        </DialogDescription>
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
