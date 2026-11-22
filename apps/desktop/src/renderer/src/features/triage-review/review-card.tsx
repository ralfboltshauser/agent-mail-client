import { BUCKETS } from '@amc/protocol'
import { useId } from 'react'
import { Button } from '@/components/ui/button'
import { Kbd } from '@/components/ui/kbd'
import type { Preview } from './model'
import { ReviewAvatar } from './review-avatar'

export interface ReviewControls {
  accountAddress: string
  run: (key: string) => void
  unavailable: (key: string) => string | undefined
}

export function ReviewCard({ card, controls }: { card: Preview | null; controls: ReviewControls }) {
  if (!card) return null
  return <CardPreview card={card} controls={controls} />
}

function CardPreview({ card, controls }: { card: Preview; controls: ReviewControls }) {
  const subjectId = useId()
  const message = card.detail.messages.find(({ id }) => id === card.messageId)
  const from = message?.from
  const { thread } = card.detail
  const address = card.sender?.address ?? from?.address
  const sender = from?.name || address || 'Unknown sender'
  const choice = (key: string, label: string, hint = key.toUpperCase()) => {
    const unavailable = controls.unavailable(key)
    return (
      <Button
        key={key}
        variant="outline"
        size="sm"
        aria-disabled={!!unavailable}
        className="justify-between aria-disabled:opacity-55"
        title={unavailable}
        onClick={() => controls.run(key)}
      >
        {label} <Kbd>{hint}</Kbd>
      </Button>
    )
  }
  return (
    <article
      aria-labelledby={subjectId}
      className="grid max-w-2xl gap-5 rounded-xl border bg-card p-5 shadow-sm sm:p-7"
    >
      <div className="flex min-w-0 items-center gap-3">
        <ReviewAvatar card={card} />
        <div className="min-w-0 break-words">
          <p className="text-sm font-semibold">{sender}</p>
          {address && sender !== address && (
            <p className="text-sm text-muted-foreground">{address}</p>
          )}
          <p className="text-xs text-muted-foreground">Account {controls.accountAddress}</p>
        </div>
      </div>
      <section className="grid gap-2 break-words">
        <p className="text-xs font-medium text-muted-foreground">
          {card.id.kind === 'sender' ? 'New sender · Representative Thread' : 'Low confidence'}
        </p>
        <h2 id={subjectId} className="text-xl font-semibold tracking-tight">
          {message?.subject || thread.subject || '(no subject)'}
        </h2>
        <p className="line-clamp-4 text-sm leading-relaxed">{message?.snippet || thread.snippet}</p>
        {card.id.kind === 'thread' && (
          <p className="text-sm text-muted-foreground">
            {thread.bucket?.bucket} · {card.reason}
          </p>
        )}
        {!!card.suggestions?.length && (
          <details className="text-sm">
            <summary>Agent suggestions ({card.suggestions.length})</summary>
            <ul className="mt-2 space-y-2 text-muted-foreground">
              {card.suggestions.map(({ actionId, author, decision, reason }) => (
                <li key={actionId}>
                  <strong>{author}</strong> suggests{' '}
                  {decision === 'accept' ? 'accepting' : 'blocking'} this Sender. {reason}
                </li>
              ))}
            </ul>
          </details>
        )}
      </section>
      <fieldset className="grid gap-2">
        <legend className="mb-2 text-sm font-medium">Sender</legend>
        <div className="flex flex-wrap gap-2">
          {choice('a', 'Accept sender · Keep in Inbox')}
          {choice('x', 'Block sender · Move to Screened out')}
        </div>
      </fieldset>
      <fieldset className="grid gap-2">
        <legend className="mb-2 text-sm font-medium">This Thread</legend>
        <div className="flex flex-wrap gap-2">
          {choice('e', 'Archive')}
          {choice('s', 'Snooze')}
          {choice('r', 'Reply')}
        </div>
        <fieldset className="grid grid-cols-2 gap-2 sm:grid-cols-3">
          <legend className="sr-only">Choose a Bucket</legend>
          {BUCKETS.map((bucket, i) => choice(String(i + 1), bucket))}
        </fieldset>
      </fieldset>
    </article>
  )
}
