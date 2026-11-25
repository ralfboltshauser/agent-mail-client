import { ChevronDown, Moon, Sun } from 'lucide-react'
import { useId, useState } from 'react'
import { Badge } from '@/components/ui/badge'
import { Button } from '@/components/ui/button'
import { SenderAvatar } from '@/features/sender-avatar/sender-avatar'
import { fullDate, listDate, personName } from '@/lib/format'
import { cn } from '@/lib/utils'
import type { ReplicaThreadMessage } from '../../../../shared/api'
import { MessageAttachments } from './message-attachments'
import { MessageContent } from './message-content'
import { MessageDetails } from './message-details'

export function Message({
  message: m,
  defaultOpen,
  onEditDraft,
  draftEditingDisabled,
}: {
  message: ReplicaThreadMessage
  defaultOpen: boolean
  onEditDraft?: (messageId: string, imapRevision?: string) => void
  draftEditingDisabled?: boolean
}) {
  const [{ open, visited }, setExpansion] = useState({ open: defaultOpen, visited: defaultOpen })
  const [darkAppearance, setDarkAppearance] = useState(true)
  const [htmlAvailable, setHtmlAvailable] = useState(false)
  const bodyId = useId()
  const showAppearance = open && m.hasHtml && htmlAvailable
  const appearanceAction = darkAppearance ? 'Show original colors' : 'Try dark background'
  const isDraft = m.labelIds.includes(`${m.accountId}:DRAFT`)

  return (
    <div
      className={cn(
        'rounded-lg border bg-card',
        isDraft && 'border-dashed border-primary/50',
        isDraft && onEditDraft && 'grid grid-cols-[minmax(0,1fr)_auto] items-start',
      )}
    >
      <div className={cn('relative', open && 'pb-3.5')}>
        <button
          type="button"
          className={cn(
            'flex w-full items-start gap-3 rounded-lg py-3.5 pr-4 pl-[3.75rem] text-left hover:bg-muted/45',
            open && 'pb-0',
          )}
          aria-expanded={open}
          aria-controls={bodyId}
          onClick={() => setExpansion((current) => ({ open: !current.open, visited: true }))}
        >
          <SenderAvatar
            className="absolute top-3.5 left-4"
            accountId={m.accountId}
            address={m.from?.address}
            name={m.from?.name}
          />
          <div className="min-w-0 flex-1">
            <div className="flex items-baseline gap-2">
              <span className="truncate text-sm font-semibold">{personName(m.from)}</span>
              {isDraft && <Badge className="h-4 px-1.5 text-[10px]">Draft</Badge>}
              <time
                className="ml-auto shrink-0 text-xs text-muted-foreground tabular-nums"
                dateTime={new Date(m.sentAt).toISOString()}
                title={open ? undefined : fullDate(m.sentAt)}
              >
                {open ? fullDate(m.sentAt) : listDate(m.sentAt)}
              </time>
            </div>
            {!open && <div className="truncate text-[13px] text-muted-foreground">{m.snippet}</div>}
          </div>
          <ChevronDown
            aria-hidden
            className={cn(
              'mt-0.5 size-3.5 shrink-0 text-muted-foreground',
              open && 'rotate-180',
              showAppearance && 'ml-8',
            )}
          />
        </button>
        {open && (
          <div className={cn('mr-[2.625rem] ml-[3.75rem]', showAppearance && 'mr-[4.625rem]')}>
            <MessageDetails message={m} />
          </div>
        )}
        {showAppearance && (
          <Button
            type="button"
            variant="ghost"
            size="icon-lg"
            className="absolute top-1 right-8 text-muted-foreground"
            aria-label={appearanceAction}
            aria-controls={bodyId}
            title={appearanceAction}
            onClick={() => setDarkAppearance((current) => !current)}
          >
            {darkAppearance ? <Sun className="size-[15px]" /> : <Moon className="size-[15px]" />}
          </Button>
        )}
      </div>
      {isDraft && onEditDraft && (
        <Button
          type="button"
          variant="outline"
          size="sm"
          className="mt-2.5 mr-3 shrink-0 aria-disabled:opacity-50"
          aria-disabled={draftEditingDisabled}
          onClick={() => {
            if (!draftEditingDisabled) onEditDraft(m.id, m.imapDraftRevision)
          }}
        >
          Edit draft
        </Button>
      )}
      <div id={bodyId} hidden={!open} className="col-span-full px-4 pt-2 pb-5 sm:pl-[3.75rem]">
        {visited && (
          <MessageContent
            message={m}
            darkAppearance={darkAppearance}
            onHtmlAvailable={setHtmlAvailable}
          />
        )}
        {open && m.bodySearchTruncated && (
          <p className="mt-2 text-xs text-muted-foreground">
            Search indexes only the start of this message.
          </p>
        )}
        {open && <MessageAttachments message={m} />}
      </div>
    </div>
  )
}
