import { Agentation } from 'agentation'
import { useEffect, useEffectEvent, useRef, useState } from 'react'
import { createPortal, flushSync } from 'react-dom'
import { toast } from 'sonner'
import { Button } from '@/components/ui/button'
import { getAmc } from '@/lib/amc'
import { type FeedbackDraft, feedbackView } from '../../../../shared/feedback'

type Status =
  | 'annotating'
  | 'reviewing'
  | 'capturing'
  | 'sending'
  | 'failed'
  | 'copied'
  | 'copied-with-screenshot'

export default function FeedbackSession({
  scope,
  onClose,
}: {
  scope: HTMLElement
  onClose: () => void
}) {
  const [status, setStatus] = useState<Status>('annotating')
  const markdown = useRef('')
  const note = useRef<HTMLTextAreaElement>(null)
  const closeButton = useRef<HTMLButtonElement>(null)
  const submitted = useRef<{ draft: FeedbackDraft; id?: string }>(null)
  const [failure, setFailure] = useState('')
  const showToolbar = status === 'annotating' || status === 'reviewing' || status === 'capturing'
  const busy = status === 'capturing' || status === 'sending'

  function close() {
    if (busy) return
    const id = submitted.current?.id
    if (id)
      void getAmc()
        .feedback.release(id)
        .catch(() => {})
    onClose()
  }

  async function deliver() {
    if (submitted.current) return
    const api = getAmc().feedback
    const draft = { text: note.current?.value ?? '', markdown: markdown.current }
    const submission: { draft: FeedbackDraft; id?: string } = { draft }
    submitted.current = submission
    const view = feedbackView(
      document.querySelector('[data-feedback-view]')?.getAttribute('data-feedback-view'),
    )
    // Commit visible, settled markers before asking Electron for the composited window.
    flushSync(() => setStatus('capturing'))
    await new Promise<void>((resolve) =>
      requestAnimationFrame(() => requestAnimationFrame(() => resolve())),
    )
    try {
      const { id } = await api.capture(view)
      submission.id = id
      setStatus('sending')
      const result = await api.send(id, draft)
      if (!result.opened) {
        fail(result.reason)
        return
      }
      toast.success('Opened in T3')
      void api.release(id).catch(() => {})
      onClose()
    } catch {
      fail(
        submission.id
          ? 'AMC could not reach its feedback service.'
          : 'AMC could not capture the window.',
      )
    }
  }

  function fail(reason: string) {
    toast.error(reason)
    setFailure(reason)
    setStatus('failed')
  }

  function review(output: string) {
    if (status !== 'annotating') return
    markdown.current = output
    setStatus('reviewing')
  }

  function finishAnnotations() {
    const copy = scope
      .querySelector('agentation-toolbar')
      ?.shadowRoot?.querySelector<HTMLButtonElement>('[data-agentation-copy]:enabled')
    // The Copy callback supplies Agentation's own formatter output, including layout and drawings.
    if (copy) copy.click()
    else review('')
  }

  const onKeyDown = useEffectEvent((event: KeyboardEvent) => {
    if (event.key !== 'Escape' && !((event.metaKey || event.ctrlKey) && event.key === 'Enter'))
      return
    // Radix handles Escape in document capture. The feedback session gets first refusal.
    event.preventDefault()
    event.stopImmediatePropagation()
    if (event.isComposing || event.keyCode === 229 || busy) return
    if (event.key === 'Escape') close()
    else if (status === 'annotating') finishAnnotations()
    else if (status === 'reviewing') void deliver()
  })

  // biome-ignore lint/correctness/useExhaustiveDependencies: React Effect Events stay outside the dependency list.
  useEffect(() => {
    const handleKeyDown = (event: KeyboardEvent) => onKeyDown(event)
    window.addEventListener('keydown', handleKeyDown, true)
    // Agentation listens on the document. Keep AMC's window-level hotkeys out of feedback mode.
    const stopMailHotkeys = (event: KeyboardEvent) => event.stopPropagation()
    document.addEventListener('keydown', stopMailHotkeys)
    return () => {
      window.removeEventListener('keydown', handleKeyDown, true)
      document.removeEventListener('keydown', stopMailHotkeys)
    }
  }, [])

  useEffect(() => {
    if (status === 'reviewing') note.current?.focus({ preventScroll: true })
    if (!showToolbar && !busy) closeButton.current?.focus({ preventScroll: true })
  }, [showToolbar, busy, status])

  async function copy() {
    const item = submitted.current
    if (!item) return
    try {
      if (item.id) await getAmc().feedback.copy(item.id, item.draft)
      else
        await navigator.clipboard.writeText(
          [item.draft.text, item.draft.markdown].filter(Boolean).join('\n\n'),
        )
      setStatus(item.id ? 'copied-with-screenshot' : 'copied')
    } catch {
      toast.error('AMC could not copy the feedback.')
    }
  }

  return (
    <>
      {showToolbar && (
        <Agentation
          appName="AMC"
          portalContainer={scope === document.body ? undefined : scope}
          localSession
          captureMarkers={status !== 'annotating'}
          onExit={close}
          copyToClipboard={false}
          onCopy={review}
          onSubmit={review}
        />
      )}
      {status !== 'annotating' &&
        status !== 'capturing' &&
        createPortal(
          <section
            aria-label="Send Feedback"
            data-feedback-toolbar
            className="pointer-events-auto fixed top-12 right-5 z-[60] grid max-w-[min(26rem,calc(100%-2.5rem))] gap-2 rounded-lg border bg-background p-2 text-sm text-foreground shadow-lg [-webkit-app-region:no-drag]"
          >
            {status === 'reviewing' ? (
              <div className="flex items-center gap-2">
                <textarea
                  ref={note}
                  aria-label="General feedback note"
                  placeholder="General note (optional)"
                  rows={1}
                  maxLength={10000}
                  className="min-w-0 resize-y rounded-md border bg-background px-2 py-1"
                />
                <Button size="sm" onClick={() => void deliver()}>
                  Send to T3
                </Button>
              </div>
            ) : (
              <>
                {status === 'sending' && <output>Opening T3…</output>}
                {status === 'failed' && <p role="alert">{failure}</p>}
                {status === 'copied' && <output>Feedback copied.</output>}
                {status === 'copied-with-screenshot' && (
                  <output>Feedback copied. The screenshot is in Finder.</output>
                )}
                {!busy && (
                  <div className="flex justify-end gap-2">
                    {status === 'failed' && (
                      <Button size="sm" onClick={copy}>
                        Copy feedback
                      </Button>
                    )}
                    <Button ref={closeButton} size="sm" variant="outline" onClick={close}>
                      Close
                    </Button>
                  </div>
                )}
              </>
            )}
          </section>,
          scope,
        )}
    </>
  )
}
