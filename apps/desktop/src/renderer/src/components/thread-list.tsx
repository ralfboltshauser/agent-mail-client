import type { ThreadSummary } from '@amc/protocol'
import { useVirtualizer } from '@tanstack/react-virtual'
import { Paperclip, Star } from 'lucide-react'
import { useEffect, useId, useRef } from 'react'
import { Badge } from '@/components/ui/badge'
import { Tooltip, TooltipContent, TooltipTrigger } from '@/components/ui/tooltip'
import { listDate, participantsLine } from '@/lib/format'
import { cn } from '@/lib/utils'

const ROW = 74

interface Props {
  threads: ThreadSummary[]
  selectedId: string | null
  onSelect: (id: string) => void
  self: Set<string>
  empty: React.ReactNode
  onMove: (delta: number) => void
  /** Search hits carry a highlighted match line. */
  matchSnippets?: Map<string, string>
}

export function ThreadList({
  threads,
  selectedId,
  onSelect,
  self,
  empty,
  onMove,
  matchSnippets,
}: Props) {
  const listId = useId()
  const scrollRef = useRef<HTMLDivElement>(null)
  const virtualizer = useVirtualizer({
    count: threads.length,
    getScrollElement: () => scrollRef.current,
    estimateSize: () => ROW,
    overscan: 12,
  })

  // Keep the selection in view when moving with j/k.
  const selectedIndex = selectedId ? threads.findIndex((t) => t.id === selectedId) : -1
  useEffect(() => {
    if (selectedIndex >= 0) virtualizer.scrollToIndex(selectedIndex, { align: 'auto' })
  }, [selectedIndex, virtualizer])

  if (threads.length === 0) return empty

  return (
    <div
      ref={scrollRef}
      className="mail-list h-full overflow-y-auto overscroll-contain p-1.5"
      role="listbox"
      aria-label="Threads"
      aria-activedescendant={selectedIndex >= 0 ? `${listId}-${selectedIndex}` : undefined}
      tabIndex={0}
      onKeyDown={(event) => {
        if (event.key !== 'ArrowDown' && event.key !== 'ArrowUp') return
        event.preventDefault()
        onMove(event.key === 'ArrowDown' ? 1 : -1)
      }}
    >
      <div style={{ height: virtualizer.getTotalSize(), position: 'relative' }}>
        {virtualizer.getVirtualItems().map((item) => {
          const t = threads[item.index]
          if (!t) return null
          const selected = t.id === selectedId
          const unread = t.unreadCount > 0
          const match = matchSnippets?.get(t.id)
          return (
            // biome-ignore lint/a11y/useFocusableInteractive: DOM focus stays on the listbox with aria-activedescendant.
            // biome-ignore lint/a11y/useKeyWithClickEvents: Each option is selected by the listbox keyboard handler.
            <div
              key={t.id}
              role="option"
              id={`${listId}-${item.index}`}
              aria-posinset={item.index + 1}
              aria-setsize={threads.length}
              aria-selected={selected}
              onClick={() => {
                onSelect(t.id)
                scrollRef.current?.focus({ preventScroll: true })
              }}
              className={cn(
                'mail-row absolute inset-x-0 flex cursor-default gap-2.5 rounded-md border-b border-border/60 px-3 py-2',
                selected ? 'bg-accent' : 'hover:bg-muted/70',
              )}
              style={{ height: ROW, transform: `translateY(${item.start}px)` }}
            >
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
                    {participantsLine(t.participants, self)}
                  </span>
                  {t.messageCount > 1 && (
                    <span className="shrink-0 text-xs text-muted-foreground tabular-nums">
                      {t.messageCount}
                    </span>
                  )}
                  <span className="ml-auto flex shrink-0 items-center gap-1.5 text-xs text-muted-foreground tabular-nums">
                    {t.hasAttachments && (
                      <>
                        <Paperclip aria-hidden className="size-3" />
                        <span className="sr-only">Attachment</span>
                      </>
                    )}
                    {t.starred && (
                      <>
                        <Star aria-hidden className="size-3 fill-current text-star" />
                        <span className="sr-only">Starred</span>
                      </>
                    )}
                    <time dateTime={new Date(t.lastMessageAt).toISOString()}>
                      {listDate(t.lastMessageAt)}
                    </time>
                  </span>
                </div>
                <div
                  className={cn(
                    'truncate text-[13px]',
                    unread ? 'font-semibold text-foreground' : 'text-foreground/85',
                  )}
                >
                  {t.subject || '(no subject)'}
                </div>
                <div className="flex items-center gap-2">
                  <span className="min-w-0 flex-1 truncate text-xs text-muted-foreground">
                    {match ? <MatchSnippet text={match} /> : t.snippet}
                  </span>
                  {t.bucket && (
                    <Tooltip>
                      <TooltipTrigger asChild>
                        <Badge
                          variant="secondary"
                          className="h-[18px] max-w-[45%] shrink text-[10px] text-muted-foreground"
                        >
                          <span className="truncate">{t.bucket.bucket}</span>
                        </Badge>
                      </TooltipTrigger>
                      <TooltipContent className="max-w-64 break-words">
                        {t.bucket.reason}
                      </TooltipContent>
                    </Tooltip>
                  )}
                </div>
              </div>
            </div>
          )
        })}
      </div>
    </div>
  )
}

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
