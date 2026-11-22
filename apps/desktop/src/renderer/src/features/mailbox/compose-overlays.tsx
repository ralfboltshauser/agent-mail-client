import type { AccountSummary } from '@amc/protocol'
import { SquarePen } from 'lucide-react'
import { Composer } from '@/components/composer'
import { HandoffDialog } from '@/components/handoff-dialog'
import { Button } from '@/components/ui/button'
import type { useMailCompose } from './use-mail-compose'

export function ComposeOverlays({
  accounts,
  compose,
}: {
  accounts: AccountSummary[]
  compose: ReturnType<typeof useMailCompose>
}) {
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
          accounts={accounts}
          onQueued={queued}
          onDiscarded={() => setDraft(null)}
          onMinimise={(subject) => {
            setMinimised({ id: draft.id, subject })
            setDraft(null)
          }}
        />
      )}
    </>
  )
}
