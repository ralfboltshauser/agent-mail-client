import { useEffect, useId, useRef, useState } from 'react'
import { createPortal } from 'react-dom'
import { Button } from '@/components/ui/button'
import { getAmc } from '@/lib/amc'
import type {
  FeedbackAnnotation,
  FeedbackCapture,
  FeedbackDraft,
} from '../../../../shared/feedback'
import { annotationTarget } from './annotation-target'

export default function FeedbackDialog({
  capture,
  onClose,
}: {
  capture: FeedbackCapture | null
  onClose: () => void
}) {
  const titleId = useId()
  const dialog = useRef<HTMLDialogElement>(null)
  const focus = useRef<HTMLTextAreaElement>(null)
  const done = useRef<HTMLButtonElement>(null)
  const [text, setText] = useState('')
  const [annotations, setAnnotations] = useState<
    Array<{ id: string; annotation: FeedbackAnnotation }>
  >([])
  const [picking, setPicking] = useState(false)
  const [target, setTarget] = useState<Omit<FeedbackAnnotation, 'note'> | null>(null)
  const [note, setNote] = useState('')
  const [locationError, setLocationError] = useState('')
  const [delivery, setDelivery] = useState<'idle' | 'sending' | 'sent' | 'failed' | 'copied'>(
    'idle',
  )
  const [copyError, setCopyError] = useState(false)
  const submitted = useRef<FeedbackDraft>(null)
  const busy = delivery === 'sending'

  useEffect(() => {
    const panel = dialog.current
    if (!panel) return
    if (picking) {
      panel.close()
      done.current?.focus()
    } else {
      panel.showModal()
      focus.current?.focus()
    }
    return () => panel.close()
  }, [picking])

  useEffect(() => {
    function onKeyDown(event: KeyboardEvent) {
      if (event.key !== 'Escape' && !picking) return
      // Radix listens for Escape in document capture, before the native dialog's cancel event.
      event.preventDefault()
      event.stopImmediatePropagation()
      if (picking && ['Enter', ' '].includes(event.key) && !event.isComposing) setPicking(false)
      if (event.key === 'Escape' && !event.isComposing && event.keyCode !== 229 && !busy) {
        dialog.current?.close()
        onClose()
      }
    }
    window.addEventListener('keydown', onKeyDown, true)
    return () => window.removeEventListener('keydown', onKeyDown, true)
  }, [busy, picking, onClose])

  function close() {
    dialog.current?.close()
    onClose()
  }

  function pick(event: React.MouseEvent<HTMLButtonElement>) {
    setPicking(false)
    if (!capture || innerWidth !== capture.width || innerHeight !== capture.height) {
      setLocationError('The window size changed. Reopen Send Feedback to annotate the new capture.')
      return
    }
    const element = document
      .elementsFromPoint(event.clientX, event.clientY)
      .find(
        (node) =>
          !node.closest('[data-feedback-overlay]') &&
          node !== document.body &&
          node !== document.documentElement,
      )
    if (element) setTarget(annotationTarget(element))
  }

  function addNote() {
    if (!target || !note.trim()) return
    const annotation = { id: crypto.randomUUID(), annotation: { ...target, note: note.trim() } }
    setAnnotations((current) => [...current, annotation])
    setTarget(null)
    setNote('')
  }

  async function send(skipText = false) {
    if (!capture || submitted.current) return
    const pending = annotations.map(({ annotation }) => annotation)
    if (target && note.trim()) pending.push({ ...target, note: note.trim() })
    const draft = { text: skipText ? '' : text, annotations: pending }
    submitted.current = draft
    setDelivery('sending')
    try {
      const { opened } = await getAmc().feedback.send(capture.id, draft)
      if (opened) close()
      else setDelivery('sent')
    } catch {
      setDelivery('failed')
    }
  }

  async function copy() {
    if (!capture || !submitted.current) return
    try {
      await getAmc().feedback.copy(capture.id, submitted.current)
      setCopyError(false)
      setDelivery('copied')
    } catch {
      setCopyError(true)
    }
  }

  return (
    <>
      {picking &&
        createPortal(
          <div
            data-feedback-overlay
            onPointerDown={(event) => event.stopPropagation()}
            className="fixed inset-0 z-[100] pointer-events-auto [-webkit-app-region:no-drag]"
          >
            <button
              type="button"
              aria-label="Pick an element to annotate"
              tabIndex={-1}
              className="absolute inset-0 size-full cursor-crosshair"
              onClick={pick}
            />
            <div className="absolute right-4 bottom-4 flex items-center gap-3 rounded-lg border bg-background p-3 text-sm shadow-lg">
              <span>Click an element to annotate it.</span>
              <Button ref={done} variant="outline" onClick={() => setPicking(false)}>
                Done
              </Button>
            </div>
          </div>,
          document.body,
        )}
      <dialog
        ref={dialog}
        data-feedback-overlay
        aria-labelledby={titleId}
        className="pointer-events-auto fixed m-auto w-[min(28rem,calc(100%-2rem))] rounded-lg border bg-background p-5 text-foreground shadow-lg backdrop:bg-black/35"
        onCancel={(event) => {
          event.preventDefault()
          if (!busy) close()
        }}
        onKeyDown={(event) => {
          event.stopPropagation()
          if (
            (event.metaKey || event.ctrlKey) &&
            event.key === 'Enter' &&
            !event.nativeEvent.isComposing
          ) {
            event.preventDefault()
            void send()
          }
        }}
      >
        <div className="grid gap-4">
          <h2 id={titleId} className="text-lg font-semibold">
            Send Feedback
          </h2>
          {!capture && (
            <p role="alert" className="text-sm">
              AMC could not capture its window. Close this dialog and try again.
            </p>
          )}
          {delivery === 'sent' && (
            <output className="text-sm">Feedback sent. Open T3 Code to find the new thread.</output>
          )}
          {delivery === 'failed' && (
            <p role="alert" className="text-sm">
              T3 Code could not confirm the feedback thread. Check AMC’s pairing or copy the
              feedback to use in T3.
            </p>
          )}
          {delivery === 'copied' && (
            <output className="text-sm">Feedback copied. The screenshot is in Finder.</output>
          )}
          {copyError && (
            <p role="alert" className="text-sm">
              AMC could not copy the feedback.
            </p>
          )}
          {capture && delivery === 'idle' && (
            <>
              <label className="grid gap-2 text-sm font-medium">
                What’s wrong / what do you want?
                <textarea
                  ref={target ? undefined : focus}
                  value={text}
                  onChange={(event) => setText(event.target.value)}
                  maxLength={10000}
                  rows={3}
                  className="resize-y rounded-md border bg-background p-2"
                />
              </label>
              {target && (
                <label className="grid gap-2 text-sm font-medium">
                  Annotation {annotations.length + 1}
                  <textarea
                    ref={focus}
                    value={note}
                    onChange={(event) => setNote(event.target.value)}
                    maxLength={2000}
                    rows={2}
                    className="resize-y rounded-md border bg-background p-2"
                  />
                </label>
              )}
              {annotations.length > 0 && (
                <ol className="grid max-h-32 list-decimal gap-1 overflow-auto ps-5 text-sm">
                  {annotations.map(({ id, annotation }, index) => (
                    <li key={id}>
                      <span className="wrap-anywhere">{annotation.note}</span>
                      <Button
                        variant="ghost"
                        size="sm"
                        aria-label={`Remove annotation ${index + 1}`}
                        onClick={() =>
                          setAnnotations((current) => current.filter((entry) => entry.id !== id))
                        }
                      >
                        Remove
                      </Button>
                    </li>
                  ))}
                </ol>
              )}
              {locationError && (
                <p role="alert" className="text-sm">
                  {locationError}
                </p>
              )}
              {target ? (
                <div className="flex gap-2">
                  <Button variant="outline" onClick={addNote} disabled={!note.trim()}>
                    Add note
                  </Button>
                  <Button
                    variant="ghost"
                    onClick={() => {
                      setTarget(null)
                      setNote('')
                    }}
                  >
                    Discard note
                  </Button>
                </div>
              ) : (
                <Button
                  variant="outline"
                  className="justify-self-start"
                  onClick={() => setPicking(true)}
                  disabled={annotations.length >= 20 || !!locationError}
                >
                  Annotate
                </Button>
              )}
            </>
          )}
          <div className="flex flex-wrap justify-end gap-2">
            <Button variant="ghost" onClick={close} disabled={busy}>
              {delivery === 'idle' ? 'Cancel' : 'Close'}
            </Button>
            {capture && delivery === 'idle' && (
              <>
                <Button variant="outline" onClick={() => void send(true)}>
                  Skip text, open in T3
                </Button>
                <Button onClick={() => void send()}>Send to T3</Button>
              </>
            )}
            {busy && <output className="self-center text-sm">Opening T3…</output>}
            {delivery === 'failed' && <Button onClick={() => void copy()}>Copy feedback</Button>}
          </div>
        </div>
      </dialog>
    </>
  )
}
