import { useState } from 'react'
import { toast } from 'sonner'
import { Button } from '@/components/ui/button'
import {
  Dialog,
  DialogContent,
  DialogDescription,
  DialogTitle,
  DialogTrigger,
} from '@/components/ui/dialog'
import { getAmc } from '@/lib/amc'

export function ResolveDelivery({
  id,
  onRestore,
}: {
  id: string
  onRestore: (id: string) => void
}) {
  const [open, setOpen] = useState(false)
  const [pending, setPending] = useState(false)
  const [reopened, setReopened] = useState(false)

  async function resolve(action: 'check' | 'reopen') {
    if (pending) return
    setPending(true)
    try {
      const { draftId } = await getAmc().resolveSend(id, action)
      if (action === 'check') {
        toast.info('Checking Sent for this message')
      } else {
        setOpen(false)
        setReopened(true)
        onRestore(draftId)
      }
    } catch (cause) {
      toast.error((cause as Error).message)
    } finally {
      setPending(false)
    }
  }

  if (reopened) return null

  return (
    <div className="flex gap-2">
      <Button size="sm" variant="outline" disabled={pending} onClick={() => void resolve('check')}>
        Check Sent again
      </Button>
      <Dialog open={open} onOpenChange={setOpen}>
        <DialogTrigger asChild>
          <Button size="sm" variant="ghost" disabled={pending}>
            Reopen draft…
          </Button>
        </DialogTrigger>
        <DialogContent>
          <DialogTitle>Reopen this draft?</DialogTitle>
          <DialogDescription>
            The original message may have reached its recipients. Check Sent before deciding whether
            to send a new copy.
          </DialogDescription>
          <Button
            className="justify-self-end"
            disabled={pending}
            onClick={() => void resolve('reopen')}
          >
            Reopen draft
          </Button>
        </DialogContent>
      </Dialog>
    </div>
  )
}
