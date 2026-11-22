import { Check } from 'lucide-react'
import { Dialog } from 'radix-ui'
import { Button } from '@/components/ui/button'
import type { Preview } from './model'
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

export function BlockSender({
  card,
  onClose,
  onFocus,
  onConfirm,
}: {
  card: Preview
  onClose: () => void
  onFocus: () => void
  onConfirm: () => void
}) {
  return (
    <Dialog.Root
      open
      onOpenChange={(open) => {
        if (!open) onClose()
      }}
    >
      <Dialog.Portal>
        <Dialog.Overlay className="fixed inset-0 z-50 bg-black/45" />
        <Dialog.Content
          className="fixed top-1/2 left-1/2 z-50 grid w-[min(28rem,calc(100%-2rem))] -translate-x-1/2 -translate-y-1/2 gap-4 rounded-lg border bg-background p-5"
          onCloseAutoFocus={(event) => {
            event.preventDefault()
            onFocus()
          }}
        >
          <Dialog.Title className="font-semibold">Block {card.sender?.address}?</Dialog.Title>
          <Dialog.Description className="text-sm text-muted-foreground">
            Matching Inbox mail and future arrivals from this address on this Account will go to
            Screened out.
          </Dialog.Description>
          <div className="flex justify-end gap-2">
            <Button onClick={onClose} variant="outline">
              Cancel
            </Button>
            <Button onClick={onConfirm} variant="destructive">
              Block sender
            </Button>
          </div>
        </Dialog.Content>
      </Dialog.Portal>
    </Dialog.Root>
  )
}
