import {
  type ComposeDraft,
  type ComposeStart,
  DRAFT_RECOVERY_PENDING,
  type OutboxItem,
  THREAD_DRAFT_UNAVAILABLE,
  type ThreadSummary,
} from '@amc/protocol'
import { useCallback, useEffect, useRef, useState } from 'react'
import { toast } from 'sonner'
import type { ComposerFocus } from '@/components/composer'
import { DRAFT_POLL_INTERVAL, isMissingDraft } from '@/features/composer/draft-availability'
import { getAmc } from '@/lib/amc'
import { failureText } from '@/lib/failure'
import type { MailLinkDraft } from '../../../../shared/api'
import { showQueuedSend } from './send-undo'

export function useMailCompose(
  thread: ThreadSummary | null,
  composeAccountId: string | undefined,
  onQueued?: (item: OutboxItem, elapsed: number) => (() => void) | undefined,
) {
  const [draft, setDraft] = useState<ComposeDraft | null>(null)
  const composerFocus = useRef<ComposerFocus>(null)
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

  const hasDraft = draft !== null
  const loadDraft = useCallback(
    async (load: () => Promise<ComposeDraft>, id?: string) => {
      if (opening.current || hasDraft) return
      opening.current = true
      setOpeningComposer(true)
      try {
        setDraft(await load())
        setMinimised(null)
      } catch (cause) {
        if (id && isMissingDraft(cause)) {
          setMinimised((current) => (current?.id === id ? null : current))
        }
        const hint = [THREAD_DRAFT_UNAVAILABLE, DRAFT_RECOVERY_PENDING].find(
          (message) => cause instanceof Error && cause.message.includes(message),
        )
        const failure = failureText(cause)
        toast.error('Could not open draft', { description: hint ? `${hint} ${failure}` : failure })
      } finally {
        opening.current = false
        setOpeningComposer(false)
      }
    },
    [hasDraft],
  )

  const openDraft = (id: string) => loadDraft(() => getAmc().composeDraft(id), id)
  const openLinkedDraft = ({ draftId, engineOrigin }: MailLinkDraft) => {
    if (draft?.id === draftId) {
      composerFocus.current?.focus()
      return
    }
    if (draft || opening.current || handoffThread) {
      toast.info('Finish or minimise the current composer, then open the draft link again.')
      return
    }
    return loadDraft(() => getAmc().composeDraft(draftId, engineOrigin), draftId)
  }
  const openDraftByMessage = useCallback(
    (messageId: string, imapRevision?: string) =>
      void loadDraft(() => getAmc().composeDraftByMessage(messageId, imapRevision)),
    [loadDraft],
  )

  const startCompose = async (mode: ComposeStart['mode'], target = thread) => {
    if (opening.current || draft || (mode !== 'new' && !target)) return
    if (mode === 'new' && minimised) return openDraft(minimised.id)
    const from = mode !== 'new' ? target?.accountId : composeAccountId
    if (!from) {
      toast.error('Add an Account before composing.')
      return
    }
    opening.current = true
    setOpeningComposer(true)
    try {
      const next = await getAmc().startCompose({
        mode,
        accountId: from,
        threadId: mode === 'new' ? undefined : target?.id,
      })
      setDraft(next)
      return next
    } catch (cause) {
      toast.error('Could not open draft', { description: failureText(cause) })
    } finally {
      opening.current = false
      setOpeningComposer(false)
    }
  }

  const queued = (item: OutboxItem, requestElapsedMs: number) => {
    const onCancelled = onQueued?.(item, requestElapsedMs)
    setDraft(null)
    showQueuedSend(item, requestElapsedMs, () => {
      setMinimised({ id: item.draftId, subject: item.subject })
      onCancelled?.()
    })
  }

  return {
    draft,
    composerFocus,
    setDraft,
    handoffThread,
    setHandoffThread,
    openingComposer,
    minimised,
    setMinimised,
    openDraft,
    openLinkedDraft,
    openDraftByMessage,
    startCompose,
    queued,
  }
}
