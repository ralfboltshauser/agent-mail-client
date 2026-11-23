import type { VirtualItem } from '@tanstack/react-virtual'
import { ChevronDown, ChevronRight } from 'lucide-react'
import { memo, useRef } from 'react'
import { runOrganise } from '@/components/organise'
import { Button } from '@/components/ui/button'
import { Kbd } from '@/components/ui/kbd'
import { Tooltip, TooltipContent, TooltipTrigger } from '@/components/ui/tooltip'
import { replicaStoreFor } from '@/data/replica-store'
import type { InboxSection } from '@/data/thread-queries'
import { accountsQuery, type MailboxThreadQuery } from '@/features/mailbox/mailbox-queries'
import {
  type InboxItem,
  type InboxNavigation,
  UPDATES_PREVIEW,
} from '@/features/mailbox/use-inbox-sections'
import { SenderAvatar } from '@/features/sender-avatar/sender-avatar'
import { useReplicaSelector } from '@/hooks/use-amc'
import { getAmc } from '@/lib/amc'
import { cn } from '@/lib/utils'

export const InboxSectionHeader = memo(function InboxSectionHeader({
  section,
  query,
  collapsed,
  preview,
  onToggle,
  controls,
}: {
  section: InboxSection
  query: MailboxThreadQuery | null
  collapsed: boolean
  preview: boolean
  onToggle: (section: InboxSection) => void
  controls: string
}) {
  const count = useReplicaSelector(query, ({ data }) => data?.inbox?.sections[section].count ?? 0)
  const hasUnread = useReplicaSelector(
    query,
    ({ data }) => (data?.inbox?.sections[section].unread ?? 0) > 0,
  )
  const marking = useRef(false)
  const canMark = !collapsed && hasUnread
  const markSeen = async () => {
    if (!query || !canMark || marking.current) return
    const data = replicaStoreFor(getAmc()).getQuery(query).data
    const inbox = data?.inbox
    if (!inbox) return
    const { ids } = inbox.sections[section]
    const visibleIds = preview ? ids.slice(0, UPDATES_PREVIEW) : ids
    const threadIds =
      section === 'New senders'
        ? visibleIds.flatMap((id) => inbox.cards.get(id)?.threadIds ?? [])
        : visibleIds
    const unread = threadIds.flatMap((id) => {
      const thread = data.summaries.get(id)
      return thread && thread.unreadCount > 0 ? [thread] : []
    })
    marking.current = true
    try {
      await Promise.all(
        unread.map((thread) =>
          runOrganise(
            { kind: 'read', threadId: thread.id, value: true },
            `Marked as read · ${thread.subject || '(no subject)'}`,
          ),
        ),
      )
    } finally {
      marking.current = false
    }
  }
  const Chevron = collapsed ? ChevronRight : ChevronDown
  const newSenders = section === 'New senders'
  const showHint = newSenders && !collapsed && !!getAmc().smartInbox
  const markButton = (
    <Button
      variant="ghost"
      size="sm"
      aria-label={`Mark ${section} seen`}
      aria-disabled={!canMark}
      className="h-10 rounded-none pr-5 focus-visible:ring-inset aria-disabled:opacity-50"
      onClick={() => void markSeen()}
    >
      Mark seen
    </Button>
  )
  return (
    <div className="border-b">
      <div className="flex">
        <h3 className="min-w-0 flex-1">
          <Button
            data-inbox-disclosure
            variant="ghost"
            size="sm"
            aria-expanded={!collapsed}
            aria-controls={controls}
            onClick={() => onToggle(section)}
            className="flex h-10 w-full cursor-pointer justify-start rounded-none font-semibold focus-visible:ring-inset has-[>svg]:pl-4.5"
          >
            <Chevron aria-hidden />
            <span className="truncate">{section}</span>
            <span className="text-xs tabular-nums text-muted-foreground">{count}</span>
          </Button>
        </h3>
        {newSenders ? (
          <Tooltip>
            <TooltipTrigger asChild>{markButton}</TooltipTrigger>
            <TooltipContent>Mark Threads as read without deciding</TooltipContent>
          </Tooltip>
        ) : (
          markButton
        )}
      </div>
      {showHint && (
        <p className="px-5 pb-1 text-xs text-muted-foreground">
          Accept or block each sender.
          {getAmc().smartInbox?.review && (
            <>
              {' '}
              Press <Kbd>T</Kbd> to review.
            </>
          )}
        </p>
      )}
    </div>
  )
})

export const InboxSenderCard = memo(function InboxSenderCard({
  id,
  query,
  avatarVisible,
}: {
  id: string
  query: MailboxThreadQuery | null
  avatarVisible: boolean
}) {
  const card = useReplicaSelector(query, ({ data }) => data?.inbox?.cards.get(id))
  const account = useReplicaSelector(
    accountsQuery(),
    ({ data }) => data?.find(({ id }) => id === card?.accountId)?.address,
  )
  if (!card) return null
  return (
    <>
      <SenderAvatar
        accountId={card.accountId}
        messageId={avatarVisible ? card.messageId : undefined}
        address={card.address}
        name={card.name === card.address ? undefined : card.name}
        className="self-center"
      />
      <div className="grid min-w-0 flex-1 text-xs">
        <div className="flex items-center gap-2">
          <span className={cn('truncate text-[13px]', card.unread && 'font-semibold')}>
            {card.name}
          </span>
          {card.unread && <span className="sr-only">Unread</span>}
          <span className="ml-auto shrink-0 text-muted-foreground">
            {card.threadIds.length} {card.threadIds.length === 1 ? 'Thread' : 'Threads'}
          </span>
        </div>
        <span className="truncate text-muted-foreground" title={card.address}>
          {card.address}
        </span>
        <span className="truncate text-muted-foreground group-data-[sender-actions]:pr-28">
          Account {account ?? card.accountId}
        </span>
        <span className="truncate group-data-[sender-actions]:pr-28">
          {card.subject || '(no subject)'}
        </span>
      </div>
    </>
  )
})

export function VirtualInboxChrome({
  entry,
  item,
  listId,
  query,
  inbox,
  measure,
  onFocusChange,
}: {
  entry: Extract<InboxItem, { kind: 'header' | 'footer' }>
  item: VirtualItem
  listId: string
  query: MailboxThreadQuery | null
  inbox: InboxNavigation
  measure: (element: HTMLDivElement | null) => void
  onFocusChange: (id: string | null) => void
}) {
  return (
    // biome-ignore lint/a11y/noStaticElementInteractions: Track focus on native controls to keep their virtual item mounted.
    <div
      id={`${listId}-${entry.id}`}
      data-index={item.index}
      ref={measure}
      className="absolute inset-x-0"
      style={{ transform: `translateY(${item.start}px)` }}
      onFocus={() => onFocusChange(entry.id)}
      onBlur={(event) => {
        if (!event.currentTarget.contains(event.relatedTarget)) onFocusChange(null)
      }}
    >
      {entry.kind === 'header' ? (
        <InboxSectionHeader
          section={entry.section}
          query={query}
          collapsed={!!inbox.collapsed[entry.section]}
          preview={entry.section === 'Updates' && !inbox.showAll}
          onToggle={inbox.toggle}
          controls={listId}
        />
      ) : (
        <div className="flex min-h-10 items-center px-2">
          <Button variant="ghost" size="sm" onClick={inbox.toggleUpdates}>
            {inbox.showAll ? 'Show less' : 'Show all'}
          </Button>
        </div>
      )}
    </div>
  )
}
