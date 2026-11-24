import type { DiscardDraftResult } from '@amc/protocol'
import { toast } from 'sonner'
import { failureText } from './failure'

export async function discardDraftWithFeedback(discard: () => Promise<DiscardDraftResult>) {
  try {
    const result = await discard()
    if ('absent' in result) {
      toast.info('This draft is already gone. It may have been sent or discarded elsewhere.')
    } else {
      const message = result.providerRemoved
        ? `Draft discarded. The matching copy is gone from ${result.providerRemoved}.`
        : 'Draft discarded'
      if (result.warning) toast.warning(message, { description: result.warning })
      else toast.success(message)
    }
    return true
  } catch (cause) {
    toast.error('Could not discard draft', { description: failureText(cause) })
    return false
  }
}
