import type { DiscardDraftResult } from '@amc/protocol'
import { useRef, useState } from 'react'
import { discardDraftWithFeedback } from '@/lib/discard-draft'
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
      if (await discardDraftWithFeedback(onConfirm)) onClose()
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
