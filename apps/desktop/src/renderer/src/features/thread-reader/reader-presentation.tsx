import { type ComponentProps, type RefObject, useLayoutEffect, useRef, useState } from 'react'
import { ThreadView } from '@/components/thread-view'
import type { ThreadWithMessages } from '../../../../shared/api'

const HANDOFF_TIMEOUT_MS = 1500

// A ready outgoing document stays painted while the next view lays out at the
// same width. Promoting the keyed view keeps its already loaded document.
export function ReaderPresentation({
  data,
  selectedId,
  readerRef,
  ...view
}: Omit<ComponentProps<typeof ThreadView>, 'data'> & {
  data: ThreadWithMessages | undefined | null
  selectedId: string | undefined
  readerRef: RefObject<HTMLDivElement | null>
}) {
  const [presented, setPresented] = useState(data ?? null)
  const [releasedId, setReleasedId] = useState<string>()
  const visibleLayer = useRef<HTMLDivElement>(null)
  const stagedLayer = useRef<HTMLDivElement>(null)
  const { loading, expanded, scrollRef } = view
  if (releasedId !== undefined && releasedId !== selectedId) setReleasedId(undefined)
  const pendingId =
    selectedId &&
    selectedId !== releasedId &&
    presented &&
    presented.thread.id !== selectedId &&
    (data || loading) &&
    presented.messages.some((message) => message.hasHtml)
      ? selectedId
      : undefined
  const switching = pendingId !== undefined
  const hasIncomingData = data != null
  const visible =
    switching || (loading && presented?.thread.id === selectedId) ? presented : (data ?? null)
  if (!switching && presented !== visible) setPresented(visible)

  useLayoutEffect(() => {
    if (!pendingId) return
    const outgoing = visibleLayer.current
    const incoming = hasIncomingData ? stagedLayer.current : null
    let active = true
    const check = () => {
      if (!active) return
      const hasReadyHtml = [...(outgoing?.querySelectorAll('[data-reader-html-ready]') ?? [])].some(
        (frame) => !frame.closest('[hidden]'),
      )
      const hasPendingBody = [
        ...(incoming?.querySelectorAll('[data-reader-body-pending]') ?? []),
      ].some((body) => !body.closest('[hidden]'))
      if (!hasReadyHtml || (incoming && !hasPendingBody)) setReleasedId(pendingId)
    }
    const observer = incoming ? new MutationObserver(check) : null
    if (incoming && observer) {
      observer.observe(incoming, {
        childList: true,
        subtree: true,
        attributes: true,
        attributeFilter: ['data-reader-body-pending', 'hidden'],
      })
    }
    queueMicrotask(check)
    return () => {
      active = false
      observer?.disconnect()
    }
  }, [pendingId, hasIncomingData])

  useLayoutEffect(() => {
    if (!pendingId) return
    const timer = window.setTimeout(() => setReleasedId(pendingId), HANDOFF_TIMEOUT_MS)
    return () => window.clearTimeout(timer)
  }, [pendingId])

  const visibleId = visible?.thread.id
  useLayoutEffect(() => {
    const active = document.activeElement
    if (switching && active && visibleLayer.current?.contains(active)) {
      readerRef.current?.focus({ preventScroll: true })
    } else if (
      visibleId &&
      !switching &&
      (active === readerRef.current || (expanded && active === document.body))
    ) {
      scrollRef?.current?.focus({ preventScroll: true })
    }
  }, [expanded, readerRef, scrollRef, switching, visibleId])

  return (
    <div className="relative min-h-0 flex-1" aria-busy={switching || undefined}>
      {visible ? null : <ThreadView {...view} data={null} />}
      {[visible, switching ? data : null].map((layer, index) => {
        if (!layer) return null
        const staged = index === 1
        return (
          <div
            key={layer.thread.id}
            ref={staged ? stagedLayer : visibleLayer}
            inert={switching}
            className={staged ? 'absolute inset-0 opacity-0' : 'h-full'}
          >
            <ThreadView {...view} data={layer} scrollRef={switching ? undefined : scrollRef} />
          </div>
        )
      })}
    </div>
  )
}
