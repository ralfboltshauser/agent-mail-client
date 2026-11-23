import { Check } from 'lucide-react'
import { Button } from '@/components/ui/button'
import type { ReviewStore } from './store'
import { useReviewValue } from './use-review-value'

export function ReviewState({
  store,
  message,
  busy,
  error,
  onReviewSkipped,
}: {
  store: ReviewStore
  message: string
  busy: boolean
  error: string | null
  onReviewSkipped: () => void
}) {
  const finished = useReviewValue(store, (view) => view.finished)
  const skipped = useReviewValue(store, (view) => view.skipped)
  const pending = useReviewValue(store, (view) => view.pending)
  const storageError = useReviewValue(store, (view) => view.storageError)
  const notice = useReviewValue(store, (view) => view.notice)
  const hasCard = useReviewValue(store, (view) => Boolean(view.card))
  return (
    <>
      {finished && !error && !busy && (
        <section className="rounded-xl border p-8 text-center motion-safe:animate-in motion-safe:fade-in-0 motion-safe:duration-150">
          <Check className="mx-auto mb-3 size-7" aria-hidden />
          <h2 className="text-lg font-semibold">
            {skipped ? `${skipped} skipped` : pending ? 'Waiting for queued actions' : 'All clear'}
          </h2>
          {pending > 0 && (
            <p className="mt-1 text-sm text-muted-foreground">
              {pending} {pending === 1 ? 'card is' : 'cards are'} awaiting a queued action.
            </p>
          )}
          {skipped > 0 && (
            <Button className="mt-4" size="sm" variant="outline" onClick={onReviewSkipped}>
              Review skipped
            </Button>
          )}
        </section>
      )}
      {error && (
        <div className="mt-3 flex flex-wrap items-center gap-2">
          <p role="alert" className="text-sm text-destructive">
            {error}
          </p>
          <Button size="sm" variant="outline" onClick={() => void store.refresh()}>
            Retry
          </Button>
        </div>
      )}
      <p aria-live="polite" className="mt-3 min-h-5 text-sm text-muted-foreground">
        {message || (busy ? (hasCard ? 'Checking review…' : 'Loading triage queue…') : notice)}
        {storageError && ' Review progress could not be saved on this Mac.'}
      </p>
    </>
  )
}
