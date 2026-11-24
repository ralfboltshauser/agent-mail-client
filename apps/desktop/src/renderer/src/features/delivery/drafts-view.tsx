import { FileText, Trash2 } from 'lucide-react'
import { memo, useCallback, useEffect, useRef, useState } from 'react'
import { DiscardDraftDialog } from '@/components/discard-draft-dialog'
import { MailLoading, MailState } from '@/components/mail-state'
import { Button } from '@/components/ui/button'
import { getAmc } from '@/lib/amc'
import { discardDraftWithFeedback } from '@/lib/discard-draft'
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
  const draftList = useRef<HTMLDivElement>(null)
  const discarding = useRef(new Set<string>())

  useEffect(() => {
    const list = draftList.current
    if (!list) return
    // This cue only changes the icon style. Keep modifier events out of the row render path.
    const updateCommand = (event: KeyboardEvent) =>
      list.toggleAttribute('data-command-held', event.metaKey)
    const clearCommand = () => list.removeAttribute('data-command-held')
    window.addEventListener('keydown', updateCommand, true)
    window.addEventListener('keyup', updateCommand, true)
    window.addEventListener('blur', clearCommand)
    return () => {
      window.removeEventListener('keydown', updateCommand, true)
      window.removeEventListener('keyup', updateCommand, true)
      window.removeEventListener('blur', clearCommand)
    }
  }, [])

  const discardDraft = useCallback(
    async (draft: Draft) => {
      const result = await getAmc().discardDraft(draft.id, draft.revision)
      setDiscarded((ids) => [...ids, draft.id])
      onDiscarded(draft.id)
      return result
    },
    [onDiscarded],
  )

  const requestDiscard = useCallback(
    async (draft: Draft, immediate: boolean) => {
      const pending = discarding.current
      if (pending.has(draft.id)) return
      if (!immediate) {
        setDiscard(draft)
        return
      }
      pending.add(draft.id)
      try {
        await discardDraftWithFeedback(() => discardDraft(draft))
      } finally {
        pending.delete(draft.id)
      }
    },
    [discardDraft],
  )

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
      <div
        ref={draftList}
        className="group/drafts"
        onPointerEnter={(event) =>
          event.currentTarget.toggleAttribute('data-command-held', event.metaKey)
        }
      >
        {drafts?.map((draft) => (
          <DraftRow key={draft.id} draft={draft} onOpen={onOpen} onDiscard={requestDiscard} />
        ))}
      </div>
      {discard && (
        <DiscardDraftDialog
          subject={discard.subject}
          onClose={() => setDiscard(null)}
          onConfirm={() => discardDraft(discard)}
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
  onDiscard: (draft: Draft, immediate: boolean) => Promise<void>
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
        title="Discard draft (⌘-click to discard immediately)"
        onClick={(event) => void onDiscard(draft, event.metaKey)}
      >
        <Trash2 className="group-data-[command-held]/drafts:text-red-700 dark:group-data-[command-held]/drafts:text-red-400" />
      </Button>
    </div>
  )
})
