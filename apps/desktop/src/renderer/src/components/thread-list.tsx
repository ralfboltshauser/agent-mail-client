import type { ThreadSummary } from '@amc/protocol'
import { defaultRangeExtractor, useVirtualizer } from '@tanstack/react-virtual'
import {
  type MouseEvent,
  useCallback,
  useEffect,
  useId,
  useImperativeHandle,
  useLayoutEffect,
  useMemo,
  useRef,
  useState,
} from 'react'
import { replicaStoreFor } from '@/data/replica-store'
import { INBOX_SECTIONS } from '@/data/thread-queries'
import type { MailboxThreadQuery } from '@/features/mailbox/mailbox-queries'
import type { FilterAction } from '@/features/mailbox/use-filter-actions'
import { type InboxNavigation, inboxHeaderId } from '@/features/mailbox/use-inbox-sections'
import { InboxSenderCard, VirtualInboxChrome } from '@/features/thread-list/inbox-chrome'
import { InboxSenderActions } from '@/features/thread-list/inbox-sender-actions'
import { ThreadContextMenu } from '@/features/thread-list/thread-context-menu'
import { SubscribedThreadRow } from '@/features/thread-list/thread-row'
import { useInboxScrollAnchor } from '@/features/thread-list/use-inbox-scroll-anchor'
import { useReplicaSelector } from '@/hooks/use-amc'
import { getAmc } from '@/lib/amc'
import { cn } from '@/lib/utils'

const ROW = 74
const LIST_PADDING = 6

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
  getFilterActions?: (thread: ThreadSummary) => FilterAction[]
  inbox?: InboxNavigation
  /** Search hits carry a highlighted match line. */
  matchSnippets?: Map<string, string>
}

export function ThreadList({
  ids: flatIds,
  query,
  fallbackRows,
  notification,
  selectedId,
  onSelect,
  self,
  empty,
  onMove,
  inbox,
  matchSnippets,
  getFilterActions,
}: Props) {
  const listId = useId()
  const scrollRef = useRef<HTMLDivElement>(null)
  const listRef = useRef<HTMLDivElement>(null)
  const getScrollElement = useCallback(() => scrollRef.current, [])
  const layout = useReplicaSelector(inbox ? query : null, ({ data }) => inbox?.readLayout(data))
  const visibleIds = useReplicaSelector(inbox ? query : null, ({ data }) => inbox?.readIds(data))
  const hasMail = useReplicaSelector(
    inbox ? query : null,
    ({ data }) => (data?.ids.length ?? 0) > 0,
  )
  const target = inbox && notification?.id === selectedId ? notification?.id : undefined
  const leadingId = target && !visibleIds?.includes(target) ? target : undefined
  const ids = useMemo(() => {
    if (!inbox) return flatIds
    if (leadingId) return [leadingId, ...(visibleIds ?? [])]
    return visibleIds ?? flatIds
  }, [inbox, flatIds, leadingId, visibleIds])
  const sectioned = layout !== undefined && (hasMail || ids.length > 0)
  const { lastOrder, scope } = inbox ?? {}
  useLayoutEffect(() => {
    if (lastOrder && scope) lastOrder.current = { scope, ids }
  }, [lastOrder, scope, ids])
  const items = useMemo(() => {
    if (!sectioned)
      return ids.map((threadId) => ({
        kind: 'thread' as const,
        id: `thread:${threadId}`,
        threadId,
      }))
    return leadingId
      ? [
          { kind: 'thread' as const, id: `thread:${leadingId}`, threadId: leadingId },
          ...layout.items,
        ]
      : layout.items
  }, [ids, layout, leadingId, sectioned])
  const positions = useMemo(() => new Map(items.map((item, index) => [item.id, index])), [items])
  const rowOrder = useMemo(() => new Map(ids.map((id, index) => [id, index + 1])), [ids])
  const rowIndexes = useMemo(() => {
    const indexes = new Map<string, number>()
    items.forEach((item, index) => {
      if ('threadId' in item) indexes.set(item.threadId, index)
    })
    return indexes
  }, [items])
  const selectedIndex = selectedId === null ? -1 : (rowIndexes.get(selectedId) ?? -1)
  const [focused, setFocused] = useState<string | null>(null)
  const focusedIndex = focused === null ? undefined : positions.get(focused)
  const getItemKey = useCallback((index: number) => items[index]?.id ?? index, [items])
  const estimateSize = useCallback(
    (index: number) => {
      const entry = items[index]
      if (entry?.kind === 'header') {
        return entry.section === 'New senders' &&
          !inbox?.collapsed[entry.section] &&
          getAmc().smartInbox
          ? 64
          : 40
      }
      if (entry?.kind === 'footer') return 40
      return entry?.kind === 'sender' ? 88 : ROW
    },
    [items, inbox?.collapsed],
  )
  const rangeExtractor = useCallback(
    (range: Parameters<typeof defaultRangeExtractor>[0]) => {
      const indexes = new Set(defaultRangeExtractor(range))
      if (selectedIndex >= 0) indexes.add(selectedIndex)
      if (focusedIndex !== undefined) indexes.add(focusedIndex)
      if (sectioned) {
        for (const section of INBOX_SECTIONS) {
          const index = positions.get(inboxHeaderId(section))
          if (index !== undefined) indexes.add(index)
        }
        const updatesFooter = positions.get('footer:Updates')
        if (updatesFooter !== undefined) indexes.add(updatesFooter)
      }
      return [...indexes].sort((a, b) => a - b)
    },
    [selectedIndex, focusedIndex, positions, sectioned],
  )
  const virtualizer = useVirtualizer({
    count: items.length,
    getScrollElement,
    estimateSize,
    getItemKey,
    rangeExtractor,
    measureElement: (element: HTMLDivElement, entry) =>
      entry?.borderBoxSize[0]?.blockSize ||
      element.offsetHeight ||
      estimateSize(Number(element.dataset.index)),
    // Include the vertical inset in the coordinates used to calculate visibility.
    paddingStart: LIST_PADDING,
    paddingEnd: LIST_PADDING,
    overscan: 12,
  })

  const focusHeader = useCallback(
    (id: string) => {
      const index = positions.get(id)
      if (index === undefined) return
      virtualizer.scrollToIndex(index, { align: 'auto' })
      document
        .getElementById(`${listId}-${id}`)
        ?.querySelector<HTMLButtonElement>('[data-inbox-disclosure]')
        ?.focus({ preventScroll: true })
    },
    [listId, positions, virtualizer],
  )
  useImperativeHandle(inbox?.focus, () => ({
    jump(delta: number) {
      const item = items[focusedIndex ?? selectedIndex]
      const section = item && 'section' in item ? INBOX_SECTIONS.indexOf(item.section) : -1
      const start = section < 0 && delta < 0 ? INBOX_SECTIONS.length : section
      const index = Math.max(0, Math.min(INBOX_SECTIONS.length - 1, start + delta))
      focusHeader(inboxHeaderId(INBOX_SECTIONS[index]))
    },
    move(delta: number) {
      if (!inbox) return false
      const start = focusedIndex ?? selectedIndex
      for (let index = start + delta; index >= 0 && index < items.length; index += delta) {
        const item = items[index]
        if ('threadId' in item) {
          onSelect(item.threadId)
          if (focusedIndex !== undefined) listRef.current?.focus({ preventScroll: true })
          virtualizer.scrollToIndex(index, { align: 'auto' })
          break
        }
      }
      return true
    },
  }))

  const previousSection = useRef<(typeof INBOX_SECTIONS)[number] | undefined>(undefined)
  const activeItem = items[selectedIndex]
  useLayoutEffect(() => {
    const previous = previousSection.current
    previousSection.current = activeItem && 'section' in activeItem ? activeItem.section : undefined
    if (!sectioned) return
    if (focused === 'footer:Updates' && focusedIndex === undefined) {
      focusHeader(inboxHeaderId('Updates'))
    } else if (selectedId === null && previous && document.activeElement === listRef.current) {
      focusHeader(inboxHeaderId(previous))
    }
  }, [activeItem, focusHeader, focused, focusedIndex, sectioned, selectedId])

  const rememberAnchor = useInboxScrollAnchor(scrollRef, virtualizer, positions, sectioned)

  const reveal = useRef({ id: selectedId, done: false })
  useEffect(() => {
    if (reveal.current.id !== selectedId) reveal.current = { id: selectedId, done: false }
    if (selectedIndex < 0 || reveal.current.done) return
    reveal.current.done = true
    virtualizer.scrollToIndex(selectedIndex, { align: 'auto' })
  }, [selectedId, selectedIndex, virtualizer])

  const focusList = useCallback(() => listRef.current?.focus({ preventScroll: true }), [])
  const openSender = inbox?.openSender
  const selectRow = useCallback(
    (event: MouseEvent<HTMLDivElement>) => {
      const id = event.currentTarget.dataset.threadId
      if (id === undefined) return
      onSelect(id)
      const sender = event.currentTarget.dataset.sender
      if (sender && query) {
        const card = replicaStoreFor(getAmc()).getQuery(query).data?.inbox?.cards.get(sender)
        if (card && card.threadIds.length > 1) openSender?.(sender)
      }
      focusList()
    },
    [focusList, onSelect, openSender, query],
  )

  if (!sectioned && ids.length === 0) return empty

  const mounted = virtualizer.getVirtualItems()
  const visible = virtualizer.range
  const selectedVisible =
    visible !== null && selectedIndex >= visible.startIndex && selectedIndex <= visible.endIndex
  return (
    <div
      ref={scrollRef}
      className="mail-list h-full overflow-y-auto overscroll-contain px-1.5"
      data-thread-viewport=""
      onScroll={rememberAnchor}
      style={sectioned ? { overflowAnchor: 'none' } : undefined}
    >
      <div style={{ height: virtualizer.getTotalSize(), position: 'relative' }}>
        <ThreadContextMenu
          listRef={listRef}
          selectedId={selectedId}
          getActions={(id) => {
            const indexed = query
              ? replicaStoreFor(getAmc()).getQuery(query).data?.summaries.get(id)
              : undefined
            const thread =
              indexed ??
              fallbackRows?.get(id) ??
              (notification?.id === id ? notification : undefined)
            return thread && getFilterActions ? getFilterActions(thread) : []
          }}
        >
          <div
            ref={listRef}
            id={listId}
            role="listbox"
            aria-label="Threads"
            aria-activedescendant={selectedIndex >= 0 ? `${listId}-${selectedId}` : undefined}
            data-active-row-visible={selectedVisible || undefined}
            tabIndex={0}
            className="mail-list absolute inset-0"
            onKeyDown={(event) => {
              if (event.target !== event.currentTarget) return
              if (event.key === 'Enter' && !event.nativeEvent.isComposing && selectedIndex >= 0) {
                document.getElementById(`${listId}-${selectedId}`)?.click()
              }
              if (event.key !== 'ArrowDown' && event.key !== 'ArrowUp') return
              event.preventDefault()
              onMove(event.key === 'ArrowDown' ? 1 : -1)
            }}
          >
            {mounted.map((item) => {
              const entry = items[item.index]
              if (!entry || !('threadId' in entry)) return null
              const id = entry.threadId
              const selected = id === selectedId
              // The mounted window also contains overscan and pinned focus/selection targets.
              const avatarVisible =
                visible !== null &&
                item.index >= visible.startIndex &&
                item.index <= visible.endIndex
              const sender = entry.kind === 'sender' ? entry.id.slice('sender:'.length) : undefined
              const row = (
                // biome-ignore lint/a11y/useFocusableInteractive: DOM focus stays on the listbox with aria-activedescendant.
                // biome-ignore lint/a11y/useKeyWithClickEvents: Each option is selected by the listbox keyboard handler.
                <div
                  key={item.key}
                  role="option"
                  id={`${listId}-${id}`}
                  data-thread-id={id}
                  data-sender={sender}
                  data-index={item.index}
                  ref={sender ? virtualizer.measureElement : undefined}
                  aria-posinset={rowOrder.get(id)}
                  aria-setsize={ids.length}
                  aria-selected={selected}
                  onClick={selectRow}
                  className={cn(
                    'mail-row absolute inset-x-0 flex cursor-default gap-2.5 rounded-md border-b border-border/60 px-3 py-2',
                    selected ? 'bg-accent' : 'hover:bg-muted/70',
                    sender && 'min-h-[88px]',
                  )}
                  style={{
                    height: sender ? undefined : item.size,
                    transform: `translateY(${item.start}px)`,
                  }}
                >
                  {sender ? (
                    <InboxSenderCard id={sender} query={query} avatarVisible={avatarVisible} />
                  ) : (
                    <SubscribedThreadRow
                      id={id}
                      query={query}
                      fallback={
                        fallbackRows?.get(id) ??
                        (notification?.id === id ? notification : undefined)
                      }
                      self={self}
                      avatarVisible={avatarVisible}
                      match={matchSnippets?.get(id)}
                    />
                  )}
                </div>
              )
              return sender && query && getAmc().smartInbox ? (
                <div key={item.key} className="group contents" data-sender-actions="">
                  {row}
                  <InboxSenderActions
                    id={sender}
                    query={query}
                    selected={selected}
                    start={item.start}
                    onFocusChange={setFocused}
                    returnFocus={focusList}
                  />
                </div>
              ) : (
                row
              )
            })}
          </div>
        </ThreadContextMenu>
        {inbox &&
          mounted.map((item) => {
            const entry = items[item.index]
            if (!entry || 'threadId' in entry) return null
            return (
              <VirtualInboxChrome
                key={item.key}
                entry={entry}
                item={item}
                listId={listId}
                query={query}
                inbox={inbox}
                measure={virtualizer.measureElement}
                onFocusChange={setFocused}
              />
            )
          })}
      </div>
    </div>
  )
}
