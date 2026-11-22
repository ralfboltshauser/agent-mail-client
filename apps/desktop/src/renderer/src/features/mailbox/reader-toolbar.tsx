import type { ThreadSummary } from '@amc/protocol'
import { Forward, Reply, ReplyAll } from 'lucide-react'
import { BucketPicker } from '@/components/bucket-picker'
import { OrganiseToolbar } from '@/components/organise'
import { Button } from '@/components/ui/button'
import type { useMailCompose } from './use-mail-compose'
import type { useThreadActions } from './use-thread-actions'

export function ReaderToolbar({
  selected,
  activeThread,
  actions,
  compose,
}: {
  selected: ThreadSummary | undefined
  activeThread: ThreadSummary | null
  actions: ReturnType<typeof useThreadActions>
  compose: ReturnType<typeof useMailCompose>
}) {
  const {
    organise,
    organiseAccount,
    activeHandoff,
    endingHandoff,
    endHandoff,
    bucketPickerOpen,
    setBucketPickerId,
    setBucket,
  } = actions
  const { openingComposer, startCompose, draft, setHandoffThread } = compose
  return (
    <div className="app-drag app-toolbar gap-0.5 overflow-x-auto px-3">
      {organise.controls.length > 0 && <OrganiseToolbar controls={organise.controls} />}
      {activeThread && organiseAccount?.kind === 'imap' && organiseAccount.imapMoves === false && (
        <span className="text-muted-foreground text-xs">
          This IMAP server does not support safe moves
        </span>
      )}
      {activeThread && (
        <>
          <Button
            size="icon-sm"
            variant="ghost"
            title="Reply (R)"
            aria-label="Reply"
            disabled={openingComposer}
            onClick={() => void startCompose('reply')}
          >
            <Reply />
          </Button>
          <Button
            size="icon-sm"
            variant="ghost"
            title="Reply all (A)"
            aria-label="Reply all"
            disabled={openingComposer}
            onClick={() => void startCompose('reply-all')}
          >
            <ReplyAll />
          </Button>
          <Button
            size="icon-sm"
            variant="ghost"
            title="Forward (F)"
            aria-label="Forward"
            disabled={openingComposer}
            onClick={() => void startCompose('forward')}
          >
            <Forward />
          </Button>
          <Button
            size="sm"
            variant="ghost"
            title="Hand off (T)"
            disabled={Boolean(draft) || openingComposer}
            onClick={() => setHandoffThread(activeThread.id)}
          >
            Hand off
          </Button>
          {activeHandoff && (
            <>
              <span className="text-xs text-muted-foreground">Active hand-off</span>
              <Button
                size="sm"
                variant="ghost"
                disabled={endingHandoff === activeHandoff.id}
                onClick={() => void endHandoff(activeHandoff.id)}
              >
                End hand-off
              </Button>
            </>
          )}
        </>
      )}
      {selected && (
        <BucketPicker
          current={selected.bucket?.bucket ?? null}
          open={bucketPickerOpen}
          onOpenChange={(open) => setBucketPickerId(open ? selected.id : null)}
          onSelect={(bucket) => void setBucket(bucket)}
        />
      )}
    </div>
  )
}
