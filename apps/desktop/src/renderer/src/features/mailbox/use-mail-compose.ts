import type { ComposeDraft, ComposeStart, OutboxItem } from '@amc/protocol'
import { useRef, useState } from 'react'
import { toast } from 'sonner'
import { getAmc } from '@/lib/amc'
import type { ThreadWithMessages } from '../../../../shared/api'
import { showQueuedSend } from './send-undo'

export function useMailCompose(
  thread: ThreadWithMessages | null,
  composeAccountId: string | undefined,
) {
  const [draft, setDraft] = useState<ComposeDraft | null>(null)
  const [handoffThread, setHandoffThread] = useState<string | null>(null)
  const [openingComposer, setOpeningComposer] = useState(false)
  const opening = useRef(false)
  const [minimised, setMinimised] = useState<{ id: string; subject: string } | null>(null)
  const openDraft = async (id: string) => {
    if (opening.current || draft) return
    opening.current = true
    setOpeningComposer(true)
    try {
      setDraft(await getAmc().composeDraft(id))
      setMinimised(null)
    } catch (cause) {
      toast.error((cause as Error).message)
    } finally {
      opening.current = false
      setOpeningComposer(false)
    }
  }

  const startCompose = async (mode: ComposeStart['mode']) => {
    if (opening.current || draft || (mode !== 'new' && !thread)) return
    if (mode === 'new' && minimised) return openDraft(minimised.id)
    const from = mode !== 'new' ? thread?.thread.accountId : composeAccountId
    if (!from) {
      toast.error('Add an Account before composing.')
      return
    }
    opening.current = true
    setOpeningComposer(true)
    try {
      setDraft(
        await getAmc().startCompose({
          mode,
          accountId: from,
          threadId: mode === 'new' ? undefined : thread?.thread.id,
        }),
      )
    } catch (cause) {
      toast.error((cause as Error).message)
    } finally {
      opening.current = false
      setOpeningComposer(false)
    }
  }

  const queued = (item: OutboxItem, requestElapsedMs: number) => {
    setDraft(null)
    showQueuedSend(item, requestElapsedMs, () => {
      setMinimised({ id: item.draftId, subject: item.subject })
    })
  }

  return {
    draft,
    setDraft,
    handoffThread,
    setHandoffThread,
    openingComposer,
    minimised,
    setMinimised,
    openDraft,
    startCompose,
    queued,
  }
}
