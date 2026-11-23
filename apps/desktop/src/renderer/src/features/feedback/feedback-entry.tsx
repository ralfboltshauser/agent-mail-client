import { lazy, Suspense, useEffect, useState } from 'react'
import { getAmc } from '@/lib/amc'

const FeedbackSession = lazy(() => import('./feedback-session'))

export function FeedbackEntry() {
  const [invoker, setInvoker] = useState<HTMLElement | null>(null)

  useEffect(
    () =>
      getAmc().feedback.onOpen(() => {
        const focus = document.activeElement
        setInvoker((current) => current ?? (focus instanceof HTMLElement ? focus : document.body))
      }),
    [],
  )

  if (!invoker) return null
  return (
    <Suspense>
      <FeedbackSession
        scope={invoker.closest<HTMLElement>('[role="dialog"]') ?? document.body}
        onClose={() => {
          setInvoker(null)
          invoker.focus({ preventScroll: true })
        }}
      />
    </Suspense>
  )
}
