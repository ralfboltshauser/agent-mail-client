import type { OutboxItem } from '@amc/protocol'
import { useCallback, useEffect, useRef, useState } from 'react'
import { getAmc } from '@/lib/amc'
import type { Preview } from './model'
import { ReviewStore } from './store'

export function useTriageReview(accountId: string | null) {
  const [store] = useState(() => new ReviewStore())
  const [open, setOpen] = useState(false)
  const initiator = useRef<HTMLElement | null>(null)
  const reply = useRef<{ card: Preview; draftId: string } | null>(null)

  useEffect(() => {
    if (!getAmc().smartInbox) return
    void store.restore().catch(() => {})
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

  const rememberReply = (card: Preview, draftId: string) => {
    reply.current = { card, draftId }
  }
  const onQueued = (item: OutboxItem, elapsed: number) => {
    const source = reply.current
    if (source?.draftId !== item.draftId) return
    reply.current = null
    const transit = Math.max(0, elapsed - (item.undoResponseElapsedMs ?? 0))
    const remaining = Math.max(0, (item.undoRemainingMs ?? 0) - transit - 1)
    store.recordReply(
      source.card,
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
