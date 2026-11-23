import { type OutboxItem, SEND_ACCOUNT_UNAVAILABLE, SEND_NEEDS_SIGN_IN } from '@amc/protocol'
import { SendHorizontal, Settings2 } from 'lucide-react'
import { memo } from 'react'
import { MailLoading, MailState } from '@/components/mail-state'
import { Button } from '@/components/ui/button'
import { getAmc } from '@/lib/amc'
import { DeliveryView } from './delivery-view'
import { CancelQueuedDelivery, QueuedDeliveryLabel } from './queued-delivery'
import { ResolveDelivery } from './resolve-delivery'
import { useDeliveryPoll } from './use-delivery-poll'

const statusText: Record<Exclude<OutboxItem['status'], 'queued'>, string> = {
  dispatching: 'Checking delivery',
  sent: 'Sent',
  cancelled: 'Cancelled',
  uncertain: 'May have been sent',
  failed: 'Rejected',
}

async function loadOutbox() {
  const items = await getAmc().outbox()
  // The relative undo timer changes on each reply and is only used by the send toast.
  return items.map((item) => ({
    id: item.id,
    accountId: item.accountId,
    draftId: item.draftId,
    messageId: item.messageId,
    subject: item.subject,
    recipients: item.to.map((recipient) => recipient.name || recipient.address).join(', '),
    status: item.status,
    sendAt: item.sendAt,
    undoUntil: item.undoUntil,
    detail: item.detail,
    canResolve: item.canResolve,
    threadId: item.threadId,
  }))
}

type Delivery = Awaited<ReturnType<typeof loadOutbox>>[number]

export function OutboxView({
  accountId,
  onRestore,
  onThread,
  onSettings,
}: {
  accountId: string | null
  onRestore: (id: string) => void
  onThread: (id: string) => void
  onSettings: () => void
}) {
  const { rows, error, refresh } = useDeliveryPoll(loadOutbox, 750)
  const items = rows?.filter((item) => !accountId || item.accountId === accountId)

  return (
    <DeliveryView
      title="Outbox"
      error={error}
      actions={
        <Button variant="ghost" size="icon-sm" aria-label="Settings" onClick={onSettings}>
          <Settings2 />
        </Button>
      }
    >
      {!rows && !error && <MailLoading label="Loading Outbox" />}
      {items?.length === 0 && (
        <MailState icon={SendHorizontal} title="Outbox is clear">
          Scheduled and recent sends appear here.
        </MailState>
      )}
      {items?.map((item) => (
        <OutboxRow
          key={item.id}
          item={item}
          stale={Boolean(error)}
          refresh={refresh}
          onRestore={onRestore}
          onThread={onThread}
        />
      ))}
    </DeliveryView>
  )
}

const OutboxRow = memo(function OutboxRow({
  item,
  stale,
  refresh,
  onRestore,
  onThread,
}: {
  item: Delivery
  stale: boolean
  refresh: () => Promise<void>
  onRestore: (id: string) => void
  onThread: (id: string) => void
}) {
  const { threadId } = item
  return (
    <article className="flex flex-wrap items-start justify-between gap-3 border-b px-5 py-4">
      <div className="min-w-0">
        <h3 className="truncate text-sm font-medium">{item.subject || '(No subject)'}</h3>
        <p className="truncate text-xs text-muted-foreground">{item.recipients}</p>
        {item.status === 'queued' ? (
          !stale && <QueuedDeliveryLabel sendAt={item.sendAt} />
        ) : (
          <p className="mt-1 text-xs">
            {item.detail?.split('\n')[0] === SEND_ACCOUNT_UNAVAILABLE
              ? SEND_NEEDS_SIGN_IN
              : statusText[item.status]}
          </p>
        )}
        {stale && <p className="mt-1 text-xs text-muted-foreground">Delivery status is stale</p>}
        {item.detail && (
          <p className="mt-1 max-w-prose select-text whitespace-pre-line text-xs text-muted-foreground">
            {item.detail}
          </p>
        )}
        {item.status === 'uncertain' && (
          <p className="mt-1 break-all font-mono text-xs text-muted-foreground">{item.messageId}</p>
        )}
      </div>
      {item.status === 'queued' && (
        <CancelQueuedDelivery
          id={item.id}
          draftId={item.draftId}
          sendAt={item.sendAt}
          undoUntil={item.undoUntil}
          disabled={stale}
          refresh={refresh}
          onRestore={onRestore}
        />
      )}
      {item.status === 'uncertain' && item.canResolve && (
        <ResolveDelivery id={item.id} onRestore={onRestore} />
      )}
      {item.status === 'failed' && (
        <Button size="sm" variant="outline" onClick={() => onRestore(item.draftId)}>
          Open draft
        </Button>
      )}
      {item.status === 'sent' && threadId && (
        <Button size="sm" variant="ghost" onClick={() => onThread(threadId)}>
          View Thread
        </Button>
      )}
    </article>
  )
})
