import { BUCKETS } from '@amc/protocol'
import { useId } from 'react'
import { Button } from '@/components/ui/button'
import { Kbd } from '@/components/ui/kbd'
import type { Preview } from './model'
import { ReviewAvatar } from './review-avatar'

export interface ReviewControls {
  accountAddress: string
  run: (key: string) => void
  reasonInput?: React.ReactNode
  senderDecision: 'accept' | 'block' | null
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
        className="h-auto min-h-8 max-w-full justify-between whitespace-normal py-1 text-left aria-disabled:opacity-55"
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
        {(card.id.kind === 'sender' || !card.suggestFilter) && (
          <p className="text-xs font-medium text-muted-foreground">
            {card.id.kind === 'sender' ? 'New sender · Sample thread' : 'Bucket needs review'}
          </p>
        )}
        <h2 id={subjectId} className="text-xl font-semibold tracking-tight">
          {message?.subject || thread.subject || '(no subject)'}
        </h2>
        <p className="line-clamp-4 text-sm leading-relaxed">{message?.snippet || thread.snippet}</p>
        {card.id.kind === 'thread' && !card.suggestFilter && (
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
      <fieldset
        aria-labelledby={`${subjectId}-sender`}
        className="grid gap-2 rounded-lg border bg-muted/40 p-3 sm:p-4"
      >
        <h3 id={`${subjectId}-sender`} className="text-sm font-semibold">
          Sender screening
        </h3>
        <p className="text-xs text-muted-foreground">
          Applies to current and future Inbox mail from this address in this account.
        </p>
        <div className="flex flex-wrap items-center gap-2">
          {controls.senderDecision && (
            <span className="rounded-md bg-accent px-2 py-1 text-xs font-medium text-accent-foreground">
              {controls.senderDecision === 'accept' ? 'Accepted' : 'Blocked'}
            </span>
          )}
          {controls.senderDecision !== 'accept' && choice('a', 'Accept sender')}
          {controls.senderDecision !== 'block' &&
            choice('x', 'Block sender · Move to Screened out')}
        </div>
      </fieldset>
      <fieldset
        aria-labelledby={`${subjectId}-thread`}
        className="grid gap-3 rounded-lg border p-3 sm:p-4"
      >
        <div className="grid gap-1">
          <h3 id={`${subjectId}-thread`} className="text-sm font-semibold">
            This thread
          </h3>
          {card.suggestFilter && <p className="text-sm font-medium">Suggested: Filter out</p>}
          <p className="text-xs text-muted-foreground">
            Filter out moves this thread’s incoming Inbox mail to Filtered.
          </p>
        </div>
        <div className="flex flex-wrap gap-2">
          {choice('f', 'Filter out')}
          {choice('e', 'Archive')}
          {choice('s', 'Snooze')}
          {choice('r', 'Reply')}
        </div>
        <fieldset
          aria-labelledby={`${subjectId}-bucket`}
          className="grid grid-cols-2 gap-2 border-t pt-3 sm:grid-cols-3"
        >
          <h4 id={`${subjectId}-bucket`} className="col-span-full text-sm font-medium">
            Keep in Inbox · Choose a bucket
          </h4>
          {BUCKETS.map((bucket, i) => choice(String(i + 1), bucket))}
        </fieldset>
      </fieldset>
      {controls.reasonInput}
    </article>
  )
}
