import { useCallback, useState, useSyncExternalStore } from 'react'
import { toast } from 'sonner'
import { Button } from '@/components/ui/button'
import { getAmc } from '@/lib/amc'

function useDeadline(deadline: number) {
  const subscribe = useCallback(
    (notify: () => void) => {
      let timer: number | undefined
      const schedule = () => {
        window.clearTimeout(timer)
        const remaining = deadline - Date.now()
        if (remaining > 0) {
          // Browser timers clamp delays above this limit.
          timer = window.setTimeout(schedule, Math.min(remaining, 2_147_483_647))
        }
        notify()
      }
      schedule()
      window.addEventListener('focus', schedule)
      document.addEventListener('visibilitychange', schedule)
      return () => {
        window.clearTimeout(timer)
        window.removeEventListener('focus', schedule)
        document.removeEventListener('visibilitychange', schedule)
      }
    },
    [deadline],
  )
  return useSyncExternalStore(subscribe, () => Date.now() >= deadline)
}

export function QueuedDeliveryLabel({ sendAt }: { sendAt: number }) {
  const due = useDeadline(sendAt)
  return (
    <p className="mt-1 text-xs">
      {due ? 'Sending…' : `Scheduled · ${new Date(sendAt).toLocaleString()}`}
    </p>
  )
}

export function CancelQueuedDelivery({
  id,
  draftId,
  sendAt,
  undoUntil,
  disabled,
  refresh,
  onRestore,
}: {
  id: string
  draftId: string
  sendAt: number
  undoUntil: number
  disabled: boolean
  refresh: () => Promise<void>
  onRestore: (id: string) => void
}) {
  const [cancelling, setCancelling] = useState(false)

  async function cancel() {
    if (disabled || cancelling) return
    setCancelling(true)
    try {
      await getAmc().cancelSend(id)
    } catch (cause) {
      toast.error('Could not cancel send', {
        description: cause instanceof Error ? cause.message : undefined,
      })
      await refresh()
      setCancelling(false)
      return
    }
    onRestore(draftId)
  }

  return (
    <Button
      size="sm"
      variant="outline"
      disabled={disabled || cancelling}
      onClick={() => void cancel()}
    >
      {sendAt > undoUntil ? 'Cancel and reopen to reschedule' : 'Cancel send'}
    </Button>
  )
}
