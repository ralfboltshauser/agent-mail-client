import { useEffect, useEffectEvent, useId, useLayoutEffect, useRef } from 'react'
import { MessageAttachments } from '@/features/thread-reader/message-attachments'
import { MessageContent } from '@/features/thread-reader/message-content'
import { messageKeydownEvent } from '@/hooks/use-hotkeys'
import { fullDate } from '@/lib/format'
import type { Preview } from './model'
import { ReviewAvatar } from './review-avatar'

export function ReviewMessage({
  card,
  accountAddress,
  onMessageKey,
}: {
  card: Preview
  accountAddress: string
  onMessageKey: (event: KeyboardEvent, frame: HTMLIFrameElement) => void
}) {
  const subjectId = useId()
  const pane = useRef<HTMLElement>(null)
  const { accountId, messageId } = card
  const message = card.detail.messages.find(({ id }) => id === messageId)
  const address = card.sender?.address ?? message?.from?.address
  const sender = message?.from?.name || address || 'Unknown sender'
  const forwardKey = useEffectEvent(onMessageKey)

  // biome-ignore lint/correctness/useExhaustiveDependencies: Reset reading position only when the selected message changes.
  useLayoutEffect(() => {
    const reader = pane.current
    if (!reader) return
    reader.scrollTop = 0
    if (document.activeElement === document.body) reader.focus({ preventScroll: true })
  }, [accountId, messageId])

  // biome-ignore lint/correctness/useExhaustiveDependencies: The Effect Event sees the current controls without reconnecting the listener.
  useEffect(() => {
    const reader = pane.current
    const onKey = (event: Event) => {
      if (event.target instanceof HTMLIFrameElement && reader?.contains(event.target)) {
        forwardKey((event as CustomEvent<KeyboardEvent>).detail, event.target)
      }
    }
    // Feedback can intercept message shortcuts at the document before they reach the window.
    window.addEventListener(messageKeydownEvent, onKey)
    return () => window.removeEventListener(messageKeydownEvent, onKey)
  }, [])

  return (
    <article
      ref={pane}
      // biome-ignore lint/a11y/noNoninteractiveTabindex: A keyboard user must be able to scroll the reader.
      tabIndex={0}
      aria-labelledby={subjectId}
      data-review-message
      className="min-w-0 overflow-y-auto overscroll-contain rounded-xl border bg-card focus-visible:outline-2 focus-visible:-outline-offset-2 focus-visible:outline-ring"
    >
      <div className="mx-auto max-w-4xl px-4 py-4 sm:px-7 sm:py-6">
        <header className="mb-4 space-y-3 border-b pb-4 wrap-anywhere">
          {(card.id.kind === 'sender' || !card.suggestFilter) && (
            <p className="text-xs font-medium text-muted-foreground">
              {card.id.kind === 'sender' ? 'New sender · Sample thread' : 'Bucket needs review'}
            </p>
          )}
          <h2 id={subjectId} className="text-xl font-semibold tracking-tight">
            {message?.subject || card.detail.thread.subject || '(no subject)'}
          </h2>
          <div className="flex items-start gap-3">
            <ReviewAvatar card={card} />
            <div className="min-w-0 flex-1">
              <p className="text-sm font-semibold">{sender}</p>
              {address && sender !== address && (
                <p className="text-sm text-muted-foreground">{address}</p>
              )}
              <p className="text-xs text-muted-foreground">Account {accountAddress}</p>
            </div>
            {message && (
              <time
                className="text-xs text-muted-foreground"
                dateTime={new Date(message.sentAt).toISOString()}
              >
                {fullDate(message.sentAt)}
              </time>
            )}
          </div>
        </header>
        {message && (
          <div key={JSON.stringify([accountId, messageId])}>
            <MessageContent message={message} />
            <MessageAttachments message={message} />
          </div>
        )}
      </div>
    </article>
  )
}
