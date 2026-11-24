import { BUCKETS } from '@amc/protocol'
import { type ReactNode, useId } from 'react'
import { Button } from '@/components/ui/button'
import { Kbd } from '@/components/ui/kbd'
import type { Preview } from './model'
import { ReviewMessage } from './review-message'

export interface ReviewControls {
  accountAddress: string
  run: (key: string) => void
  reasonInput?: ReactNode
  senderDecision: 'accept' | 'block' | null
  unavailable: (key: string) => string | undefined
}

export function ReviewCard({
  card,
  controls,
  onMessageKey,
  status,
  children,
}: {
  card: Preview | null
  controls: ReviewControls
  onMessageKey: (event: KeyboardEvent, frame: HTMLIFrameElement) => void
  status: ReactNode
  children: ReactNode
}) {
  const subjectId = useId()
  if (!card)
    return (
      <section className="mx-auto w-full max-w-2xl overflow-y-auto">
        {status}
        {children}
      </section>
    )
  const { thread } = card.detail
  const choice = (key: string, label: string, hint = key.toUpperCase()) => {
    const unavailable = controls.unavailable(key)
    return (
      <Button
        key={key}
        variant="outline"
        size="sm"
        aria-disabled={!!unavailable}
        aria-keyshortcuts={key === 'f' && card.suggestFilter ? 'F Enter' : undefined}
        className="h-auto min-h-8 max-w-full justify-between whitespace-normal py-1 text-left aria-disabled:opacity-55"
        title={unavailable}
        onClick={() => controls.run(key)}
      >
        {label} <Kbd>{hint}</Kbd>
      </Button>
    )
  }
  return (
    <div className="grid min-h-0 flex-1 gap-3 grid-rows-[minmax(0,1fr)_minmax(0,44%)] lg:grid-cols-[minmax(0,1fr)_minmax(21rem,26rem)] lg:grid-rows-[minmax(0,1fr)]">
      <ReviewMessage
        card={card}
        accountAddress={controls.accountAddress}
        onMessageKey={onMessageKey}
      />
      <aside
        aria-label="Triage decisions"
        className="min-w-0 space-y-3 overflow-y-auto overscroll-contain rounded-xl border bg-card p-3 sm:p-4"
      >
        {status}
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
        <div className="grid items-start gap-3 sm:grid-cols-[minmax(0,1fr)_minmax(0,1.65fr)] lg:grid-cols-1">
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
              {card.suggestFilter && (
                <p className="flex flex-wrap items-center gap-2 text-sm font-medium">
                  <span>Suggested: Filter out</span>
                  <Kbd>Enter</Kbd>
                </p>
              )}
              <p className="text-xs text-muted-foreground">
                Filter out moves this thread’s incoming Inbox mail to Filtered.
              </p>
            </div>
            <div className="flex flex-wrap gap-2">
              {choice('f', 'Filter out')}
              {choice('e', 'Archive')}
              {choice('s', 'Snooze')}
              {choice('r', 'Reply to thread')}
            </div>
            {card.replyTargetId && card.replyTargetId !== card.messageId && (
              <p className="text-xs text-muted-foreground">
                Reply uses the latest message in this thread.
              </p>
            )}
            <fieldset
              aria-labelledby={`${subjectId}-bucket`}
              className="grid grid-cols-2 gap-2 border-t pt-3 sm:grid-cols-3 lg:grid-cols-2"
            >
              <h4 id={`${subjectId}-bucket`} className="col-span-full text-sm font-medium">
                Keep in Inbox · Choose a bucket
              </h4>
              {BUCKETS.map((bucket, i) => choice(String(i + 1), bucket))}
            </fieldset>
          </fieldset>
        </div>
        {controls.reasonInput}
        {children}
      </aside>
    </div>
  )
}
