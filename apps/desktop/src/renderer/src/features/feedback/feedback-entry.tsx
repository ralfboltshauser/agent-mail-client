import { lazy, Suspense, useEffect, useRef, useState } from 'react'
import { getAmc } from '@/lib/amc'
import { type FeedbackCapture, feedbackView } from '../../../../shared/feedback'

const FeedbackDialog = lazy(() => import('./feedback-dialog'))

export function FeedbackEntry() {
  const [session, setSession] = useState<{ capture: FeedbackCapture | null } | null>(null)
  const opening = useRef(false)
  const invoker = useRef<HTMLElement | null>(null)

  useEffect(
    () =>
      getAmc().feedback.onOpen(() => {
        if (opening.current) return
        opening.current = true
        invoker.current =
          document.activeElement instanceof HTMLElement ? document.activeElement : null
        const view = feedbackView(
          document.querySelector('[data-feedback-view]')?.getAttribute('data-feedback-view'),
        )
        void getAmc()
          .feedback.capture(view, { width: innerWidth, height: innerHeight })
          .then(
            (capture) => setSession({ capture }),
            () => setSession({ capture: null }),
          )
      }),
    [],
  )

  if (!session) return null
  return (
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
}
