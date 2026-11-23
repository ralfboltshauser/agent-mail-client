import type { OutboxItem } from '@amc/protocol'
import { useCallback, useEffect, useRef, useState } from 'react'
import { getAmc } from '@/lib/amc'
import { recordCaughtFailure } from '@/lib/failure'
import { ReviewStore } from './store'

export function useTriageReview(accountId: string | null) {
  const [store] = useState(() => new ReviewStore())
  const [open, setOpen] = useState(false)
  const initiator = useRef<HTMLElement | null>(null)
  const replies = useRef(new Map<string, ReturnType<ReviewStore['prepareReply']>>())

  useEffect(() => {
    if (!getAmc().smartInbox?.review) return
    void store.restore().catch(recordCaughtFailure)
    const timer = setInterval(() => void store.poll(), 2000)
    const unsubscribe = getAmc().onChanged(() => store.replicaChanged())
    return () => {
      clearInterval(timer)
      unsubscribe()
      store.close()
    }
  }, [store])

  const enter = (target: Element | null) => {
    initiator.current = target instanceof HTMLElement && target !== document.body ? target : null
    store.open(accountId)
    setOpen(true)
  }

  const close = useCallback(
    (restoreFocus = true) => {
      store.close()
      setOpen(false)
      if (!restoreFocus) return
      setTimeout(() => {
        const trigger = initiator.current
        if (trigger?.isConnected) trigger.focus()
        if (!trigger || document.activeElement !== trigger) {
          document.querySelector<HTMLElement>('[data-mailbox-heading]')?.focus()
        }
      }, 0)
    },
    [store],
  )

  const rememberReply = (record: ReturnType<ReviewStore['prepareReply']>, draftId: string) => {
    replies.current.set(draftId, record)
  }
  const onQueued = (item: OutboxItem, elapsed: number) => {
    const record = replies.current.get(item.draftId)
    if (!record) return
    replies.current.delete(item.draftId)
    const transit = Math.max(0, elapsed - (item.undoResponseElapsedMs ?? 0))
    const remaining = Math.max(0, (item.undoRemainingMs ?? 0) - transit - 1)
    record(
      item.id,
      {
        kind: 'reply',
        deadline: Date.now() + remaining,
        draftId: item.draftId,
      },
      item.status !== 'sent',
    )
    return () => store.replyCancelled(item.id)
  }

  return { store, open, enter, close, rememberReply, onQueued }
}
