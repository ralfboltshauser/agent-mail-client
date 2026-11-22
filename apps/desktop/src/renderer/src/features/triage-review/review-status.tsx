import { Check } from 'lucide-react'
import { Button } from '@/components/ui/button'
import type { ReviewStore } from './store'
import { useReviewValue } from './use-review-value'

export function ReviewState({
  store,
  message,
  busy,
  error,
}: {
  store: ReviewStore
  message: string
  busy: boolean
  error: string | null
}) {
  const { finished, more, storageError, notice, card } = useReviewValue(store, (view) => view)
  return (
    <>
      {finished && !error && !busy && (
        <section className="rounded-xl border p-8 text-center motion-safe:animate-in motion-safe:fade-in-0 motion-safe:duration-150">
          <Check className="mx-auto mb-3 size-7" aria-hidden />
          <h2 className="text-lg font-semibold">{more ? 'Batch complete' : 'All clear'}</h2>
          <p className="mt-1 text-sm text-muted-foreground">
            {more ? 'More cards are available.' : 'You’re caught up with this review.'}
          </p>
          <Button
            className="mt-4"
            size="sm"
            variant="outline"
            onClick={() => void store.refresh(true)}
          >
            {more ? 'Review next batch' : 'Check for new cards'}
          </Button>
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
        {message || (busy ? (card ? 'Checking review…' : 'Loading triage queue…') : notice)}
        {storageError && ' Review progress could not be saved on this Mac.'}
      </p>
    </>
  )
}
