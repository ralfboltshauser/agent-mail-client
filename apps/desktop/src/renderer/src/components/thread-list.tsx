import type { ThreadSummary } from '@amc/protocol'
import { useVirtualizer } from '@tanstack/react-virtual'
import { Paperclip, Star } from 'lucide-react'
import { useEffect, useRef } from 'react'
import { Badge } from '@/components/ui/badge'
import { Tooltip, TooltipContent, TooltipTrigger } from '@/components/ui/tooltip'
import { listDate, participantsLine } from '@/lib/format'
import { cn } from '@/lib/utils'

const ROW = 72

interface Props {
  threads: ThreadSummary[]
  selectedId: string | null
  onSelect: (id: string) => void
  self: Set<string>
  empty: React.ReactNode
  /** Search hits carry a highlighted match line. */
  matchSnippets?: Map<string, string>
}

export function ThreadList({ threads, selectedId, onSelect, self, empty, matchSnippets }: Props) {
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

  if (threads.length === 0) {
    return (
      <div className="flex h-full items-center justify-center p-8 text-center text-sm text-muted-foreground">
        {empty}
      </div>
    )
  }

  return (
    <div
      ref={scrollRef}
      className="h-full overflow-y-auto overscroll-contain"
      role="listbox"
      aria-label="Threads"
    >
      <div style={{ height: virtualizer.getTotalSize(), position: 'relative' }}>
        {virtualizer.getVirtualItems().map((item) => {
          const t = threads[item.index]
          if (!t) return null
          const selected = t.id === selectedId
          const unread = t.unreadCount > 0
          const match = matchSnippets?.get(t.id)
          return (
            <div
              key={t.id}
              role="option"
              tabIndex={-1}
              aria-selected={selected}
              onMouseDown={() => onSelect(t.id)}
              className={cn(
                'absolute inset-x-0 flex gap-2.5 border-b border-border/60 px-4 py-2.5',
                selected ? 'bg-accent' : 'hover:bg-muted/60',
              )}
              style={{ height: ROW, transform: `translateY(${item.start}px)` }}
            >
              <div className="flex w-2 shrink-0 justify-center pt-1.5">
                {unread && (
                  <span className="size-2 rounded-full bg-unread">
                    <span className="sr-only">Unread</span>
                  </span>
                )}
              </div>
              <div className="min-w-0 flex-1">
                <div className="flex items-baseline gap-2">
                  <span
                    className={cn(
                      'truncate text-[13px]',
                      unread ? 'font-semibold text-foreground' : 'text-foreground/85',
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
                    {t.hasAttachments && <Paperclip className="size-3" />}
                    {t.starred && <Star className="size-3 fill-amber-400 text-amber-400" />}
                    {listDate(t.lastMessageAt)}
                  </span>
                </div>
                <div
                  className={cn(
                    'truncate text-[13px]',
                    unread ? 'font-medium text-foreground' : 'text-foreground/80',
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
                        <Badge variant="secondary" className="h-4 shrink-0 text-[10px]">
                          {t.bucket.bucket}
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
