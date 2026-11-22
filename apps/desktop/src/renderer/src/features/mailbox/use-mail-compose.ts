import type { ComposeDraft, ComposeStart, OutboxItem, ThreadSummary } from '@amc/protocol'
import { useEffect, useRef, useState } from 'react'
import { toast } from 'sonner'
import { DRAFT_POLL_INTERVAL, isMissingDraft } from '@/features/composer/draft-availability'
import { getAmc } from '@/lib/amc'
import { showQueuedSend } from './send-undo'

export function useMailCompose(thread: ThreadSummary | null, composeAccountId: string | undefined) {
  const [draft, setDraft] = useState<ComposeDraft | null>(null)
  const [handoffThread, setHandoffThread] = useState<string | null>(null)
  const [openingComposer, setOpeningComposer] = useState(false)
  const opening = useRef(false)
  const [minimised, setMinimised] = useState<{ id: string; subject: string } | null>(null)
  const minimisedId = minimised?.id

  useEffect(() => {
    if (!minimisedId || draft || openingComposer) return
    let active = true
    let pending = false
    const timer = setInterval(async () => {
      if (pending || opening.current) return
      pending = true
      try {
        await getAmc().composeDraft(minimisedId)
      } catch (cause) {
        if (active && !opening.current && isMissingDraft(cause)) {
          setMinimised((current) => (current?.id === minimisedId ? null : current))
        }
      } finally {
        pending = false
      }
    }, DRAFT_POLL_INTERVAL)
    return () => {
      active = false
      clearInterval(timer)
    }
  }, [minimisedId, draft, openingComposer])

  const openDraft = async (id: string) => {
    if (opening.current || draft) return
    opening.current = true
    setOpeningComposer(true)
    try {
      setDraft(await getAmc().composeDraft(id))
      setMinimised(null)
    } catch (cause) {
      if (isMissingDraft(cause)) {
        setMinimised((current) => (current?.id === id ? null : current))
      }
      toast.error((cause as Error).message)
    } finally {
      opening.current = false
      setOpeningComposer(false)
    }
  }

  const startCompose = async (mode: ComposeStart['mode']) => {
    if (opening.current || draft || (mode !== 'new' && !thread)) return
    if (mode === 'new' && minimised) return openDraft(minimised.id)
    const from = mode !== 'new' ? thread?.accountId : composeAccountId
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
          threadId: mode === 'new' ? undefined : thread?.id,
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
