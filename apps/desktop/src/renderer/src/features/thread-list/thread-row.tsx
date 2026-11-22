import { Paperclip, Star } from 'lucide-react'
import { memo } from 'react'
import { Badge } from '@/components/ui/badge'
import { Tooltip, TooltipContent, TooltipTrigger } from '@/components/ui/tooltip'
import { cn } from '@/lib/utils'

interface RowProps {
  unread: boolean
  participants: string
  messageCount: number
  hasAttachments: boolean
  starred: boolean
  dateTime: string
  dateLabel: string
  subject: string
  snippet: string
  match?: string
  bucket?: string
  bucketReason?: string
}

export const ThreadRow = memo(function ThreadRow({
  unread,
  participants,
  messageCount,
  hasAttachments,
  starred,
  dateTime,
  dateLabel,
  subject,
  snippet,
  match,
  bucket,
  bucketReason,
}: RowProps) {
  return (
    <>
      <div className="flex w-2 shrink-0 justify-center pt-1.5">
        {unread && (
          <span className="size-1.5 rounded-full bg-unread">
            <span className="sr-only">Unread</span>
          </span>
        )}
      </div>
      <div className="min-w-0 flex-1">
        <div className="flex h-[19px] items-center gap-1.5">
          <span
            className={cn(
              'truncate text-[13px]',
              unread ? 'font-semibold text-foreground' : 'font-medium text-foreground/85',
            )}
          >
            {participants}
          </span>
          {messageCount > 1 && (
            <span className="shrink-0 text-xs text-muted-foreground tabular-nums">
              {messageCount}
            </span>
          )}
          <span className="ml-auto flex shrink-0 items-center gap-1.5 text-xs text-muted-foreground tabular-nums">
            {hasAttachments && (
              <>
                <Paperclip aria-hidden className="size-3" />
                <span className="sr-only">Attachment</span>
              </>
            )}
            {starred && (
              <>
                <Star aria-hidden className="size-3 fill-current text-star" />
                <span className="sr-only">Starred</span>
              </>
            )}
            <time dateTime={dateTime}>{dateLabel}</time>
          </span>
        </div>
        <div
          className={cn(
            'truncate text-[13px]',
            unread ? 'font-semibold text-foreground' : 'text-foreground/85',
          )}
        >
          {subject}
        </div>
        <div className="flex items-center gap-2">
          <span className="min-w-0 flex-1 truncate text-xs text-muted-foreground">
            {match ? <MatchSnippet text={match} /> : snippet}
          </span>
          {bucket && (
            <Tooltip>
              <TooltipTrigger asChild>
                <Badge
                  variant="secondary"
                  className="h-[18px] max-w-[45%] shrink text-[10px] text-muted-foreground"
                >
                  <span className="truncate">{bucket}</span>
                </Badge>
              </TooltipTrigger>
              <TooltipContent className="max-w-64 break-words">{bucketReason}</TooltipContent>
            </Tooltip>
          )}
        </div>
      </div>
    </>
  )
})

/** Renders the Engine's «match» markers as highlights. */
function MatchSnippet({ text }: { text: string }) {
  const parts = text.split(/«|»/).map((part, i) => ({ part, key: `${i}:${part}` }))
  return (
    <>
      {parts.map(({ part, key }, i) =>
        i % 2 === 1 ? (
          <mark
            key={key}
            className="rounded-sm bg-amber-200/70 px-0.5 text-foreground dark:bg-amber-500/30"
          >
            {part}
          </mark>
        ) : (
          part
        ),
      )}
    </>
  )
}
