import type { ThreadSummary } from '@amc/protocol'
import { ArrowLeft, Forward, Maximize2, Reply, ReplyAll } from 'lucide-react'
import { BucketPicker } from '@/components/bucket-picker'
import { OrganiseToolbar } from '@/components/organise'
import { Button } from '@/components/ui/button'
import { Kbd } from '@/components/ui/kbd'
import { copyThreadReferenceLabel, copyThreadReferenceShortcut } from './thread-reference'
import type { FilterAction } from './use-filter-actions'
import type { useMailCompose } from './use-mail-compose'
import type { useThreadActions } from './use-thread-actions'

export function ReaderToolbar({
  expanded,
  canExpand,
  onToggleFocus,
  ...props
}: ReaderActionsProps & {
  expanded: boolean
  canExpand: boolean
  onToggleFocus: (trigger: HTMLElement) => void
}) {
  return (
    <div className="app-drag app-toolbar min-w-0 gap-1 px-3">
      {(expanded || canExpand) && (
        <Button
          variant="ghost"
          size={expanded ? 'sm' : 'icon-sm'}
          className={expanded ? 'ml-[68px] gap-2' : undefined}
          aria-label={expanded ? 'Back to mailbox' : 'Focus reader'}
          aria-keyshortcuts={expanded ? 'Escape O' : 'O'}
          title={expanded ? undefined : 'Focus reader (O)'}
          onClick={(event) => onToggleFocus(event.currentTarget)}
        >
          {expanded ? (
            <>
              <ArrowLeft />
              Back to mailbox
              <Kbd aria-hidden="true">Esc</Kbd>
            </>
          ) : (
            <Maximize2 />
          )}
        </Button>
      )}
      <div className="flex min-w-0 flex-1 items-center gap-0.5 overflow-x-auto">
        <ReaderActions {...props} />
      </div>
    </div>
  )
}

interface ReaderActionsProps {
  selected: ThreadSummary | undefined
  activeThread: ThreadSummary | null
  actions: ReturnType<typeof useThreadActions>
  compose: ReturnType<typeof useMailCompose>
  filterActions: FilterAction[]
  onCopyThreadReference: (() => void) | undefined
}

function ReaderActions({
  selected,
  activeThread,
  actions,
  compose,
  filterActions,
  onCopyThreadReference,
}: ReaderActionsProps) {
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
    <>
      {organise.controls.length > 0 && <OrganiseToolbar controls={organise.controls} />}
      {filterActions.map(({ name, shortcut, disabled, run }) => (
        <Button
          key={name}
          size="sm"
          variant="ghost"
          title={shortcut ? `${name} (${shortcut})` : undefined}
          disabled={disabled}
          onClick={run}
        >
          {name}
        </Button>
      ))}
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
            title="Hand off (⇧T)"
            disabled={Boolean(draft) || openingComposer}
            onClick={() => setHandoffThread(activeThread.id)}
          >
            Hand off
          </Button>
          {onCopyThreadReference && (
            <Button
              size="sm"
              variant="ghost"
              title={`${copyThreadReferenceLabel} (${copyThreadReferenceShortcut})`}
              aria-keyshortcuts="Meta+Shift+C"
              onClick={onCopyThreadReference}
            >
              {copyThreadReferenceLabel}
            </Button>
          )}
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
    </>
  )
}
