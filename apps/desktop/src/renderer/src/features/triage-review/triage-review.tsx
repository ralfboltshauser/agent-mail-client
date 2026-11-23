import { BUCKETS, type InboxSender, imapActionError, type Label } from '@amc/protocol'
import { Dialog } from 'radix-ui'
import { type KeyboardEvent, useRef, useState } from 'react'
import { OrganisePicker } from '@/components/organise'
import { Button } from '@/components/ui/button'
import { Kbd } from '@/components/ui/kbd'
import { useReplicaSelector, useSyncField } from '@/hooks/use-amc'
import { accountsQuery, queryFailed, selectedThreadQuery } from '../mailbox/mailbox-queries'
import { inboxMessageIds, type Preview, reviewError } from './model'
import { reviewSender } from './preview'
import { ReasonInput } from './reason-input'
import { ReviewCard } from './review-card'
import { ReviewHistory } from './review-history'
import { ReviewState } from './review-status'
import type { ReviewStore } from './store'
import { useReviewValue } from './use-review-value'

interface Props {
  store: ReviewStore
  accountId: string | null
  labels: Label[]
  suspended: boolean
  snoozeEnabled: boolean
  onClose: () => void
  onOutbox: () => void
  onReply: (card: Preview) => Promise<void>
}

export function TriageReview({
  store,
  accountId,
  labels,
  suspended,
  snoozeEnabled,
  onClose,
  onOutbox,
  onReply,
}: Props) {
  const [picker, setPicker] = useState<Preview | null>(null)
  const [reasonTarget, setReasonTarget] = useState<{
    card: Preview
    key: 'f' | 'x'
    id: string
  } | null>(null)
  const [message, setMessage] = useState('')
  const openingReply = useRef(false)
  const heading = useRef<HTMLHeadingElement>(null)
  const card = useReviewValue(store, (view) => view.card)
  const cardAccount = card?.accountId
  const engineUrl = useSyncField((status) => status?.engineUrl ?? null)
  const sender = useReplicaSelector(
    selectedThreadQuery(engineUrl, card?.detail.thread),
    ({ data }) =>
      card && (data === undefined ? card.sender : reviewSender(card, data?.thread.inboxSender)),
    sameSender,
  )
  const senderDecisionState = sender?.decision ?? (sender?.status === 'blocked' ? 'block' : null)
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
  const activeReason = reasonTarget?.card === card ? reasonTarget : null
  const focus = () => heading.current?.focus()
  const unavailable = (key: string) => {
    if (!card) return 'No card is selected.'
    if (busy) return 'Wait for the current review operation.'
    if (errors) return 'Refresh the card before making a decision.'
    if ((key === 'a' || key === 'x') && !sender) return 'This message has no eligible Sender.'
    if ((key === 'x' || key === 'f') && account.account?.imapMoves === false)
      return 'This IMAP server does not support safe moves.'
    if (key === 'r' && !card.canReply) return 'This Thread has no reply target.'
    if (key === 's' && !snoozeEnabled) return 'Snooze is disabled on this Engine.'
    if (key === 'e' || key === 's' || key === 'x' || key === 'f') {
      if (!account.account)
        return account.failed
          ? 'Account details could not be loaded.'
          : 'Account details are loading.'
      if ((key === 'e' || key === 's') && account.account.kind === 'imap') {
        return imapActionError(
          { kind: 'archive', threadId: card.threadId },
          card.accountId,
          new Set(labels.map(({ id }) => id)),
          account.account.imapMoves,
        )
      }
    }
  }
  const senderDecision = (
    card: Preview,
    decision: 'accept' | 'block',
    reason?: string,
    id: string = crypto.randomUUID(),
  ) => {
    if (!sender) return
    return store.decide(
      card,
      id,
      {
        kind: 'sender',
        input: {
          accountId: card.accountId,
          address: sender.address,
          decision,
          expectedRevision: sender.revision,
          clientActionId: id,
          source: 'triage-key',
          ...(reason ? { reason } : {}),
        },
      },
      (decision === 'accept' ? 'Accept ' : 'Block ') + sender.address,
    )
  }
  const canActOn = (target: Preview | null) => {
    if (store.view.card !== target) {
      setMessage('The review card changed. Check the current card and try again.')
      return false
    }
    if (store.busy || openingReply.current) {
      setMessage('Wait for the current review operation.')
      return false
    }
    if (store.view.error) {
      setMessage('Refresh the card before making a decision.')
      return false
    }
    return true
  }
  const closeReason = () => {
    setReasonTarget(null)
    focus()
  }
  const run = (key: string, ownerReason?: string, actionId: string = crypto.randomUUID()) => {
    setMessage('')
    if (store.view.card !== card || openingReply.current) return
    if (key === 'u') {
      const action = store.latestUndo()
      if (action) void store.undoAction(action)
      else setMessage('No triage action to undo.')
      return
    }
    if (!canActOn(card)) return
    const reason = unavailable(key)
    if (reason) {
      setMessage(reason)
      return
    }
    if (!card) return
    if (key === 'a') senderDecision(card, 'accept')
    else if (key === 'x') return senderDecision(card, 'block', ownerReason, actionId)
    else if (key === 's') setPicker(card)
    else if (key === 'r') {
      openingReply.current = true
      void onReply(card)
        .catch((error) => setMessage(reviewError(error)))
        .finally(() => {
          openingReply.current = false
        })
    } else {
      const id = actionId
      const bucket = BUCKETS[Number(key) - 1]
      if (key === ' ') void store.decide(card, id, { kind: 'skip' }, 'Skip')
      else if (key === 'f') {
        const expectedInboxMessageIds = inboxMessageIds(card, 'filter')
        if (!expectedInboxMessageIds.length) {
          setMessage('There are no eligible Inbox messages to filter.')
          return
        }
        return store.decide(
          card,
          id,
          {
            kind: 'filter',
            input: {
              threadId: card.threadId,
              decision: 'filter.filtered',
              expectedInboxMessageIds,
              ...(card.predictionId ? { predictionId: card.predictionId } : {}),
              expectedRevision: card.threadRevision,
              clientActionId: id,
              source: 'triage-key',
              ...(ownerReason ? { reason: ownerReason } : {}),
            },
          },
          'Filter out',
        )
      } else if (key === 'e')
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
              ...(card.bucketPredictionId ? { predictionId: card.bucketPredictionId } : {}),
              threadId: card.threadId,
              bucket,
              clientActionId: id,
              expectedRevision: card.threadRevision,
              reason: 'Owner triage review',
              ...(card.bucketTarget?.messageId === card.messageId
                ? { expectedBucketTarget: card.bucketTarget }
                : {}),
            },
          },
          `Bucket · ${bucket}`,
        )
    }
  }
  const onKeyDown = (event: KeyboardEvent<HTMLElement>) => {
    if (
      picker ||
      activeReason ||
      suspended ||
      event.defaultPrevented ||
      event.nativeEvent.isComposing ||
      event.keyCode === 229 ||
      event.metaKey ||
      event.ctrlKey ||
      event.altKey ||
      !(event.target instanceof HTMLElement) ||
      !event.currentTarget.contains(event.target) ||
      event.target.closest('input, textarea, select, [contenteditable="true"], [role="menu"]')
    )
      return
    if (event.shiftKey) {
      const key = event.key.toLowerCase()
      if ((key === 'f' || key === 'x') && card) {
        if (import.meta.env.VITE_AMC_PRIVATE_TRIAGE_REASONS === '0') return
        event.preventDefault()
        if (event.repeat || !canActOn(card)) return
        const reason = unavailable(key)
        if (reason) setMessage(reason)
        else setReasonTarget({ card, key, id: crypto.randomUUID() })
      }
      return
    }
    if (event.key === ' ' && event.target.closest('button, a, summary, [role="button"]')) return
    if (!['a', 'x', '1', '2', '3', '4', '5', '6', 'e', 'f', 's', 'r', ' ', 'u'].includes(event.key))
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
              if (
                picker ||
                activeReason ||
                event.isComposing ||
                event.keyCode === 229 ||
                (event.target instanceof HTMLElement &&
                  event.target.closest('[data-review-reason]'))
              )
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
                card={card}
                controls={{
                  accountAddress: account.account?.address ?? cardAccount ?? '',
                  run,
                  senderDecision: senderDecisionState,
                  unavailable,
                  reasonInput: activeReason && (
                    <ReasonInput
                      label={activeReason.key === 'f' ? 'Filter out reason' : 'Block sender reason'}
                      onCancel={closeReason}
                      onSave={async (reason) => {
                        if (!(await run(activeReason.key, reason, activeReason.id)))
                          throw new Error('Decision was not accepted')
                        closeReason()
                      }}
                    />
                  ),
                }}
              />
              <ReviewState
                store={store}
                message={message}
                busy={busy}
                error={errors}
                onReviewSkipped={() => {
                  focus()
                  void store.refresh('skipped')
                }}
              />
              <nav aria-label="Queue actions" className="mt-4 flex flex-wrap gap-2">
                <Button size="sm" variant="outline" onClick={() => run(' ')}>
                  Skip <Kbd>Space</Kbd>
                </Button>
                <Button size="sm" variant="outline" onClick={() => run('u')}>
                  Undo <Kbd>U</Kbd>
                </Button>
              </nav>
              <ReviewHistory
                store={store}
                accountId={accountId}
                labels={labels}
                onOutbox={onOutbox}
              />
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
            if (input.kind === 'snooze' && canActOn(picker))
              await store.decide(picker, crypto.randomUUID(), { kind: 'organise', input }, 'Snooze')
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

function sameSender(left: InboxSender | null, right: InboxSender | null) {
  return (
    left === right ||
    (left !== null &&
      right !== null &&
      left.accountId === right.accountId &&
      left.address === right.address &&
      left.messageId === right.messageId &&
      left.revision === right.revision &&
      left.status === right.status &&
      left.decision === right.decision)
  )
}
