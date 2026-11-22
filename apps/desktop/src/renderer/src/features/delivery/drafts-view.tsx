import { FileText, Trash2 } from 'lucide-react'
import { memo, useState } from 'react'
import { DiscardDraftDialog } from '@/components/discard-draft-dialog'
import { MailLoading, MailState } from '@/components/mail-state'
import { Button } from '@/components/ui/button'
import { getAmc } from '@/lib/amc'
import { DeliveryView } from './delivery-view'
import { useDeliveryPoll } from './use-delivery-poll'

async function loadDrafts() {
  const drafts = await getAmc().composeDrafts()
  return drafts.map(({ id, accountId, subject, revision, updatedAt, from, to }) => ({
    id,
    accountId,
    subject,
    revision,
    updatedAt,
    recipients: to.map((recipient) => recipient.name || recipient.address).join(', ') || from,
  }))
}

type Draft = Awaited<ReturnType<typeof loadDrafts>>[number]

export function DraftsView({
  accountId,
  onOpen,
  onDiscarded,
}: {
  accountId: string | null
  onOpen: (id: string) => void
  onDiscarded: (id: string) => void
}) {
  const { rows, error } = useDeliveryPoll(loadDrafts, 1500)
  const [discard, setDiscard] = useState<Draft | null>(null)
  const [discarded, setDiscarded] = useState<string[]>([])
  const drafts = rows?.filter(
    (draft) => (!accountId || draft.accountId === accountId) && !discarded.includes(draft.id),
  )

  return (
    <DeliveryView title="Drafts" error={error}>
      {!rows && !error && <MailLoading label="Loading drafts" />}
      {drafts?.length === 0 && (
        <MailState icon={FileText} title="No saved drafts">
          Messages you start writing appear here.
        </MailState>
      )}
      {drafts?.map((draft) => (
        <DraftRow key={draft.id} draft={draft} onOpen={onOpen} onDiscard={setDiscard} />
      ))}
      {discard && (
        <DiscardDraftDialog
          subject={discard.subject}
          onClose={() => setDiscard(null)}
          onConfirm={async () => {
            const result = await getAmc().discardDraft(discard.id, discard.revision)
            setDiscarded((ids) => [...ids, discard.id])
            onDiscarded(discard.id)
            return result
          }}
        />
      )}
    </DeliveryView>
  )
}

const DraftRow = memo(function DraftRow({
  draft,
  onOpen,
  onDiscard,
}: {
  draft: Draft
  onOpen: (id: string) => void
  onDiscard: (draft: Draft) => void
}) {
  const subject = draft.subject || '(No subject)'
  return (
    <div className="flex items-center border-b pr-3 hover:bg-accent">
      <button
        type="button"
        onClick={() => onOpen(draft.id)}
        className="flex min-w-0 flex-1 items-center justify-between gap-4 px-4 py-3 text-left focus-visible:outline-ring"
      >
        <span className="min-w-0">
          <span className="block truncate text-sm font-medium">{subject}</span>
          <span className="block truncate text-xs text-muted-foreground">{draft.recipients}</span>
        </span>
        <time className="shrink-0 text-xs text-muted-foreground">
          {new Date(draft.updatedAt).toLocaleDateString()}
        </time>
      </button>
      <Button
        size="icon-sm"
        variant="ghost"
        aria-label={`Discard draft: ${subject}`}
        title="Discard draft"
        onClick={() => onDiscard(draft)}
      >
        <Trash2 />
      </Button>
    </div>
  )
})
