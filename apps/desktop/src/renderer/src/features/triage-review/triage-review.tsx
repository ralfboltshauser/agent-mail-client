import { BUCKETS, imapActionError, type Label } from '@amc/protocol'
import { Check } from 'lucide-react'
import { Dialog } from 'radix-ui'
import { type KeyboardEvent, useRef, useState } from 'react'
import { OrganisePicker } from '@/components/organise'
import { Button } from '@/components/ui/button'
import { Kbd } from '@/components/ui/kbd'
import { useReplicaSelector } from '@/hooks/use-amc'
import { accountsQuery, queryFailed } from '../mailbox/mailbox-queries'
import { type Preview, reviewError } from './model'
import { ReviewCard } from './review-card'
import { ReviewHistory } from './review-history'
import type { ReviewStore } from './store'
import { useReviewValue } from './use-review-value'

interface Props {
  store: ReviewStore
  accountId: string | null
  labels: Label[]
  suspended: boolean
  snoozeEnabled: boolean
  onClose: () => void
  onReply: (card: Preview) => Promise<void>
}

export function TriageReview({
  store,
  accountId,
  labels,
  suspended,
  snoozeEnabled,
  onClose,
  onReply,
}: Props) {
  const [picker, setPicker] = useState<Preview | null>(null)
  const [block, setBlock] = useState<Preview | null>(null)
  const [message, setMessage] = useState('')
  const heading = useRef<HTMLHeadingElement>(null)
  const cardAccount = useReviewValue(store, (view) => view.card?.accountId)
  const account = useReplicaSelector(
    accountsQuery(),
    (snapshot) => ({
      account: snapshot.data?.find(({ id }) => id === cardAccount),
      failed: queryFailed(snapshot),
    }),
    (left, right) => left.account === right.account && left.failed === right.failed,
  )
  const errors = useReviewValue(store, (view) => view.error)
  const busy = useReviewValue(store, (view) => view.busy)
  const focus = () => heading.current?.focus()
  const unavailable = (key: string) => {
    const card = store.view.card
    if (!card) return 'No card is selected.'
    if (store.view.busy) return 'Wait for the current review operation.'
    if (store.view.error) return 'Refresh the card before making a decision.'
    if ((key === 'a' || key === 'x') && !card.sender) return 'This message has no eligible Sender.'
    if (key === 'x' && account.account?.imapMoves === false)
      return 'This IMAP server does not support safe moves.'
    if (key === 'r' && !card.canReply) return 'This Thread has no reply target.'
    if (key === 's' && !snoozeEnabled) return 'Snooze is disabled on this Engine.'
    if (key === 'e' || key === 's' || key === 'x') {
      if (!account.account)
        return account.failed
          ? 'Account details could not be loaded.'
          : 'Account details are loading.'
      if (key !== 'x' && account.account.kind === 'imap') {
        return imapActionError(
          { kind: 'archive', threadId: card.threadId },
          card.accountId,
          new Set(labels.map(({ id }) => id)),
          account.account.imapMoves,
        )
      }
    }
  }
  const senderDecision = (card: Preview, decision: 'accept' | 'block') => {
    if (!card.sender) return
    const id = crypto.randomUUID()
    void store.decide(
      card,
      id,
      {
        kind: 'sender',
        input: {
          accountId: card.accountId,
          address: card.sender.address,
          decision,
          expectedRevision: card.sender.revision,
          clientActionId: id,
        },
      },
      (decision === 'accept' ? 'Accept ' : 'Block ') + card.sender.address,
    )
  }
  const run = (key: string) => {
    setMessage('')
    if (key === 'u') {
      const action = store.latestUndo()
      if (action) void store.undoAction(action)
      else setMessage('No triage action to undo.')
      return
    }
    const reason = unavailable(key)
    if (reason) {
      setMessage(reason)
      return
    }
    const card = store.view.card
    if (!card) return
    if (key === 'a') senderDecision(card, 'accept')
    else if (key === 'x') setBlock(card)
    else if (key === 's') setPicker(card)
    else if (key === 'r') void onReply(card).catch((error) => setMessage(reviewError(error)))
    else {
      const id = crypto.randomUUID()
      const bucket = BUCKETS[Number(key) - 1]
      if (key === ' ') void store.decide(card, id, { kind: 'skip' }, 'Skip')
      else if (key === 'e')
        void store.decide(
          card,
          id,
          { kind: 'organise', input: { kind: 'archive', threadId: card.threadId } },
          'Archive',
        )
      else if (bucket)
        void store.decide(
          card,
          id,
          {
            kind: 'bucket',
            input: {
              intent: 'review',
              threadId: card.threadId,
              bucket,
              clientActionId: id,
              expectedRevision: card.threadRevision,
              reason: 'Owner triage review',
            },
          },
          `Bucket · ${bucket}`,
        )
    }
  }
  const onKeyDown = (event: KeyboardEvent<HTMLElement>) => {
    if (
      picker ||
      block ||
      suspended ||
      event.defaultPrevented ||
      event.nativeEvent.isComposing ||
      event.keyCode === 229 ||
      event.metaKey ||
      event.ctrlKey ||
      event.altKey ||
      event.shiftKey ||
      !(event.target instanceof HTMLElement) ||
      !event.currentTarget.contains(event.target) ||
      event.target.closest('input, textarea, select, [contenteditable="true"], [role="menu"]')
    )
      return
    if (event.key === ' ' && event.target.closest('button, a, summary, [role="button"]')) return
    if (!['a', 'x', '1', '2', '3', '4', '5', '6', 'e', 's', 'r', ' ', 'u'].includes(event.key))
      return
    event.preventDefault()
    if (!event.repeat) run(event.key)
  }

  return (
    <>
      <Dialog.Root
        open={!suspended}
        onOpenChange={(open) => {
          if (!open) onClose()
        }}
      >
        <Dialog.Portal>
          <Dialog.Content
            aria-describedby={undefined}
            onKeyDown={onKeyDown}
            className="fixed inset-0 z-40 overflow-y-auto bg-background outline-none"
            onOpenAutoFocus={(event) => {
              event.preventDefault()
              focus()
            }}
            onCloseAutoFocus={(event) => event.preventDefault()}
            onEscapeKeyDown={(event) => {
              if (picker || block || event.isComposing || event.keyCode === 229)
                event.preventDefault()
            }}
          >
            <div className="app-drag h-10" />
            <main className="mx-auto max-w-2xl px-5 pb-16">
              <header className="mb-5 flex flex-wrap items-center gap-2">
                <Dialog.Title
                  ref={heading}
                  tabIndex={-1}
                  className="mr-auto text-lg font-semibold outline-none"
                >
                  Triage Inbox
                </Dialog.Title>
                <ReviewProgress store={store} />
                <Button size="sm" variant="ghost" onClick={onClose}>
                  Exit <Kbd>Esc</Kbd>
                </Button>
              </header>
              <ReviewCard
                store={store}
                controls={{
                  accountAddress: account.account?.address ?? cardAccount ?? '',
                  run,
                  unavailable,
                }}
              />
              <ReviewState store={store} message={message} busy={busy} error={errors} />
              <nav aria-label="Queue actions" className="mt-4 flex flex-wrap gap-2">
                <Button size="sm" variant="outline" onClick={() => run(' ')}>
                  Skip <Kbd>Space</Kbd>
                </Button>
                <Button size="sm" variant="outline" onClick={() => run('u')}>
                  Undo <Kbd>U</Kbd>
                </Button>
              </nav>
              <ReviewHistory store={store} accountId={accountId} />
            </main>
          </Dialog.Content>
        </Dialog.Portal>
      </Dialog.Root>
      {picker && (
        <OrganisePicker
          picker={{ kind: 'snooze', thread: picker.detail.thread, trigger: null }}
          labels={labels}
          onClose={() => setPicker(null)}
          focusFallback={focus}
          run={async (input) => {
            if (input.kind === 'snooze')
              await store.decide(picker, crypto.randomUUID(), { kind: 'organise', input }, 'Snooze')
          }}
        />
      )}
      {block && (
        <BlockSender
          card={block}
          onClose={() => setBlock(null)}
          onFocus={focus}
          onConfirm={() => {
            setBlock(null)
            senderDecision(block, 'block')
          }}
        />
      )}
    </>
  )
}

export function ReviewProgress({ store }: { store: ReviewStore }) {
  const progress = useReviewValue(store, (view) => view.progress)
  return (
    <output aria-label="Triage progress" className="px-2 text-sm tabular-nums">
      {progress}
    </output>
  )
}

function ReviewState({
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

function BlockSender({
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
