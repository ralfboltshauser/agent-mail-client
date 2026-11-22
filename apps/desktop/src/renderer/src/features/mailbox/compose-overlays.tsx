import { SquarePen } from 'lucide-react'
import { Composer } from '@/components/composer'
import { HandoffDialog } from '@/components/handoff-dialog'
import { Button } from '@/components/ui/button'
import { useReplicaSelector } from '@/hooks/use-amc'
import { accountsQuery } from './mailbox-queries'
import type { useMailCompose } from './use-mail-compose'

export function ComposeOverlays({ compose }: { compose: ReturnType<typeof useMailCompose> }) {
  const {
    draft,
    setDraft,
    handoffThread,
    setHandoffThread,
    minimised,
    setMinimised,
    openDraft,
    queued,
  } = compose
  const accounts = useReplicaSelector(
    draft ? accountsQuery() : null,
    ({ data }) => data,
    (left, right) =>
      left === right ||
      (left !== undefined &&
        right !== undefined &&
        left.length === right.length &&
        left.every(
          (account, index) =>
            account.id === right[index].id && account.address === right[index].address,
        )),
  )
  return (
    <>
      {minimised && !draft && (
        <Button
          className="fixed right-4 bottom-4 z-20 max-w-64 shadow-md"
          variant="secondary"
          onClick={() => void openDraft(minimised.id)}
        >
          <SquarePen /> <span className="truncate">{minimised.subject || 'Resume draft'}</span>
        </Button>
      )}
      {handoffThread && (
        <HandoffDialog
          threadId={handoffThread}
          onClose={() => setHandoffThread(null)}
          onDraft={(next) => {
            setHandoffThread(null)
            setMinimised(null)
            setDraft(next)
          }}
        />
      )}
      {draft && (
        <Composer
          key={draft.id}
          draft={draft}
          accounts={accounts ?? []}
          onQueued={queued}
          onDiscarded={() => setDraft(null)}
          onKept={setDraft}
          onMinimise={(subject) => {
            setMinimised({ id: draft.id, subject })
            setDraft(null)
          }}
        />
      )}
    </>
  )
}
