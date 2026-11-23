import { ORIGINAL_DRAFT_LEFT, type OutboxItem } from '@amc/protocol'
import { toast } from 'sonner'
import { getAmc } from '@/lib/amc'
import { failureText } from '@/lib/failure'

export function showQueuedSend(
  item: OutboxItem,
  requestElapsedMs: number,
  onCancelled: () => void,
) {
  if (item.originalDraftLeft) toast.warning(ORIGINAL_DRAFT_LEFT)
  if (item.status !== 'queued') {
    toast.info(item.status === 'sent' ? 'Message sent' : 'Check the Outbox for delivery status')
    return
  }
  const message = item.sendAt > item.undoUntil ? 'Send scheduled' : 'Message queued'
  // The round trip minus measured Engine work bounds the response transit.
  const transitBudget = Math.max(0, requestElapsedMs - (item.undoResponseElapsedMs ?? 0))
  const remaining = Math.floor((item.undoRemainingMs ?? 0) - transitBudget) - 1
  if (remaining <= 0) {
    toast(message, { duration: 3000 })
    return
  }

  const deadline = performance.now() + remaining
  const wallDeadline = Date.now() + remaining
  const expired = () => performance.now() >= deadline || Date.now() >= wallDeadline
  const expire = () => {
    stop()
    toast(message, { id, action: undefined, duration: 3000 })
  }
  const checkExpiry = () => {
    if (expired()) expire()
  }
  const stop = () => {
    clearTimeout(expiry)
    window.removeEventListener('focus', checkExpiry)
    document.removeEventListener('visibilitychange', checkExpiry)
  }
  const id = toast(message, {
    duration: Infinity,
    onDismiss: stop,
    action: {
      label: 'Undo',
      onClick: () => {
        stop()
        if (expired()) {
          toast.info('The Undo window has closed')
          return
        }
        void getAmc()
          .cancelSend(item.id)
          .then(() => {
            onCancelled()
            toast.success('Send cancelled. Draft saved.')
          })
          .catch((cause: Error) =>
            toast.error('Could not undo send', { description: failureText(cause) }),
          )
      },
    },
  })
  // Sonner pauses its own timer while hovered or hidden.
  const expiry = setTimeout(expire, remaining)
  window.addEventListener('focus', checkExpiry)
  document.addEventListener('visibilitychange', checkExpiry)
}
