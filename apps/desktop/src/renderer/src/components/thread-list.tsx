import type { ThreadSummary } from '@amc/protocol'
import { defaultRangeExtractor, useVirtualizer } from '@tanstack/react-virtual'
import { type MouseEvent, useCallback, useEffect, useId, useRef } from 'react'
import type { MailboxThreadQuery } from '@/features/mailbox/mailbox-queries'
import { SubscribedThreadRow } from '@/features/thread-list/thread-row'
import { cn } from '@/lib/utils'

const ROW = 74
const estimateSize = () => ROW

interface Props {
  ids: readonly string[]
  query: MailboxThreadQuery | null
  fallbackRows?: ReadonlyMap<string, ThreadSummary>
  notification?: ThreadSummary | null
  selectedId: string | null
  onSelect: (id: string) => void
  self: Set<string>
  empty: React.ReactNode
  onMove: (delta: number) => void
  /** Search hits carry a highlighted match line. */
  matchSnippets?: Map<string, string>
}

export function ThreadList({
  ids,
  query,
  fallbackRows,
  notification,
  selectedId,
  onSelect,
  self,
  empty,
  onMove,
  matchSnippets,
}: Props) {
  const listId = useId()
  const scrollRef = useRef<HTMLDivElement>(null)
  const getScrollElement = useCallback(() => scrollRef.current, [])
  const selectedIndex = selectedId === null ? -1 : ids.indexOf(selectedId)
  // The key extractor must change when the order changes so the virtualizer rebuilds offsets.
  const getItemKey = useCallback((index: number) => ids[index] ?? index, [ids])
  const rangeExtractor = useCallback(
    (range: Parameters<typeof defaultRangeExtractor>[0]) => {
      const indexes = defaultRangeExtractor(range)
      // Keep the active descendant addressable even after it moves outside the viewport.
      if (selectedIndex >= 0 && !indexes.includes(selectedIndex)) {
        if (selectedIndex < (indexes[0] ?? 0)) indexes.unshift(selectedIndex)
        else indexes.push(selectedIndex)
      }
      return indexes
    },
    [selectedIndex],
  )
  const virtualizer = useVirtualizer({
    count: ids.length,
    getScrollElement,
    estimateSize,
    getItemKey,
    rangeExtractor,
    overscan: 12,
  })

  const reveal = useRef({ id: selectedId, done: false })
  useEffect(() => {
    if (reveal.current.id !== selectedId) reveal.current = { id: selectedId, done: false }
    if (selectedIndex < 0 || reveal.current.done) return
    reveal.current.done = true
    virtualizer.scrollToIndex(selectedIndex, { align: 'auto' })
  }, [selectedId, selectedIndex, virtualizer])

  const selectRow = useCallback(
    (event: MouseEvent<HTMLDivElement>) => {
      const id = event.currentTarget.dataset.threadId
      if (id === undefined) return
      onSelect(id)
      scrollRef.current?.focus({ preventScroll: true })
    },
    [onSelect],
  )

  if (ids.length === 0) return empty

  return (
    <div
      ref={scrollRef}
      className="mail-list h-full overflow-y-auto overscroll-contain p-1.5"
      role="listbox"
      aria-label="Threads"
      aria-activedescendant={selectedIndex >= 0 ? `${listId}-${selectedId}` : undefined}
      tabIndex={0}
      onKeyDown={(event) => {
        if (event.key !== 'ArrowDown' && event.key !== 'ArrowUp') return
        event.preventDefault()
        onMove(event.key === 'ArrowDown' ? 1 : -1)
      }}
    >
      <div style={{ height: virtualizer.getTotalSize(), position: 'relative' }}>
        {virtualizer.getVirtualItems().map((item) => {
          const id = ids[item.index]
          if (id === undefined) return null
          const selected = id === selectedId
          return (
            // biome-ignore lint/a11y/useFocusableInteractive: DOM focus stays on the listbox with aria-activedescendant.
            // biome-ignore lint/a11y/useKeyWithClickEvents: Each option is selected by the listbox keyboard handler.
            <div
              key={item.key}
              role="option"
              id={`${listId}-${id}`}
              data-thread-id={id}
              aria-posinset={item.index + 1}
              aria-setsize={ids.length}
              aria-selected={selected}
              onClick={selectRow}
              className={cn(
                'mail-row absolute inset-x-0 flex cursor-default gap-2.5 rounded-md border-b border-border/60 px-3 py-2',
                selected ? 'bg-accent' : 'hover:bg-muted/70',
              )}
              style={{ height: ROW, transform: `translateY(${item.start}px)` }}
            >
              <SubscribedThreadRow
                id={id}
                query={query}
                fallback={
                  fallbackRows?.get(id) ?? (notification?.id === id ? notification : undefined)
                }
                self={self}
                match={matchSnippets?.get(id)}
              />
            </div>
          )
        })}
      </div>
    </div>
  )
}
