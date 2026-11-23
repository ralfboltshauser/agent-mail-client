import type { ThreadSummary } from '@amc/protocol'
import { ArrowLeft, Copy, Forward, Maximize2, Reply, ReplyAll, SendToBack, X } from 'lucide-react'
import { BucketPicker } from '@/components/bucket-picker'
import { OrganiseToolbar } from '@/components/organise'
import { ToolbarButton } from '@/components/toolbar-button'
import { mailShortcuts } from '@/lib/mail-shortcuts'
import { copyThreadReferenceLabel } from './thread-reference'
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
    <div className="app-drag app-toolbar h-auto min-h-13 min-w-0 items-start px-3 py-2.5">
      <fieldset className="flex min-w-0 flex-1 flex-wrap items-center gap-0.5">
        <legend className="sr-only">Thread actions</legend>
        {(expanded || canExpand) && (
          <ToolbarButton
            className={expanded ? 'ml-[68px]' : undefined}
            label={expanded ? 'Back to mailbox' : 'Focus reader'}
            shortcuts={
              expanded
                ? [mailShortcuts.escape, mailShortcuts.focusReader]
                : [mailShortcuts.focusReader]
            }
            onClick={(event) => onToggleFocus(event.currentTarget)}
          >
            {expanded ? <ArrowLeft /> : <Maximize2 />}
          </ToolbarButton>
        )}
        <ReaderActions {...props} />
      </fieldset>
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
      <OrganiseToolbar controls={organise.controls} />
      {filterActions.map(({ name, shortcut, icon: Icon, disabled, run }) => (
        <ToolbarButton
          key={name}
          label={name}
          shortcuts={shortcut ? [shortcut] : undefined}
          disabled={disabled}
          onClick={run}
        >
          <Icon />
        </ToolbarButton>
      ))}
      {activeThread && (
        <>
          <ToolbarButton
            label="Reply"
            shortcuts={[mailShortcuts.reply]}
            disabled={openingComposer}
            onClick={() => void startCompose('reply')}
          >
            <Reply />
          </ToolbarButton>
          <ToolbarButton
            label="Reply all"
            shortcuts={[mailShortcuts.replyAll]}
            disabled={openingComposer}
            onClick={() => void startCompose('reply-all')}
          >
            <ReplyAll />
          </ToolbarButton>
          <ToolbarButton
            label="Forward"
            shortcuts={[mailShortcuts.forward]}
            disabled={openingComposer}
            onClick={() => void startCompose('forward')}
          >
            <Forward />
          </ToolbarButton>
          <ToolbarButton
            label="Hand off"
            shortcuts={[mailShortcuts.handOff]}
            disabled={Boolean(draft) || openingComposer}
            onClick={() => setHandoffThread(activeThread.id)}
          >
            <SendToBack />
          </ToolbarButton>
          {onCopyThreadReference && (
            <ToolbarButton
              label={copyThreadReferenceLabel}
              shortcuts={[mailShortcuts.copyThreadReference]}
              onClick={onCopyThreadReference}
            >
              <Copy />
            </ToolbarButton>
          )}
          {activeHandoff && (
            <span className="inline-flex items-center gap-0.5 whitespace-nowrap text-xs text-muted-foreground">
              Active hand-off
              <ToolbarButton
                label="End hand-off"
                disabled={endingHandoff === activeHandoff.id}
                onClick={() => void endHandoff(activeHandoff.id)}
              >
                <X />
              </ToolbarButton>
            </span>
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
      {activeThread && organiseAccount?.kind === 'imap' && organiseAccount.imapMoves === false && (
        <span className="text-xs text-muted-foreground">
          This IMAP server does not support safe moves
        </span>
      )}
    </>
  )
}
