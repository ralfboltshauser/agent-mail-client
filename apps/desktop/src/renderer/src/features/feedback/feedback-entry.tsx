import { lazy, Suspense, useEffect, useRef, useState } from 'react'
import { createPortal } from 'react-dom'
import { getAmc } from '@/lib/amc'
import { type FeedbackCapture, feedbackView } from '../../../../shared/feedback'

const FeedbackDialog = lazy(() => import('./feedback-dialog'))

export function FeedbackEntry() {
  const [session, setSession] = useState<{
    capture: FeedbackCapture | null
    scope: Element | null
  } | null>(null)
  const opening = useRef(false)
  const invoker = useRef<HTMLElement | null>(null)

  useEffect(
    () =>
      getAmc().feedback.onOpen(() => {
        if (opening.current) return
        opening.current = true
        invoker.current =
          document.activeElement instanceof HTMLElement ? document.activeElement : null
        // Keep focus and accessibility inside any existing Radix modal's scope.
        const scope = invoker.current?.closest('[role="dialog"]') ?? null
        const view = feedbackView(
          document.querySelector('[data-feedback-view]')?.getAttribute('data-feedback-view'),
        )
        void getAmc()
          .feedback.capture(view, { width: innerWidth, height: innerHeight })
          .then(
            (capture) => setSession({ capture, scope }),
            () => setSession({ capture: null, scope }),
          )
      }),
    [],
  )

  if (!session) return null
  const { scope } = session
  const dialog = (
    <Suspense>
      <FeedbackDialog
        capture={session.capture}
        onClose={() => {
          setSession(null)
          opening.current = false
          invoker.current?.focus({ preventScroll: true })
          if (session.capture)
            void getAmc()
              .feedback.release(session.capture.id)
              .catch(() => {})
        }}
      />
    </Suspense>
  )
  return scope ? createPortal(dialog, scope) : dialog
}
