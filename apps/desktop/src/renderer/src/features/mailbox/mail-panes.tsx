import type { ThreadSummary } from '@amc/protocol'
import { Inbox, Layers, Search } from 'lucide-react'
import { memo, type ReactNode, useMemo } from 'react'
import { MailLoading, MailState } from '@/components/mail-state'
import { ThreadList } from '@/components/thread-list'
import { ThreadView } from '@/components/thread-view'
import { Button } from '@/components/ui/button'
import { ResizableHandle, ResizablePanel, ResizablePanelGroup } from '@/components/ui/resizable'
import { replicaStoreFor } from '@/data/replica-store'
import { shareReply } from '@/data/share-reply'
import { useReplicaSelector } from '@/hooks/use-amc'
import { getAmc } from '@/lib/amc'
import type { View } from '../../../../shared/api'
import { SearchInput } from '../search/search-input'
import type { useMailSearch } from '../search/use-mail-search'
import {
  accountsQuery,
  countsQuery,
  labelsQuery,
  type MailboxThreadQuery,
  queryFailed,
  selectedThreadQuery,
} from './mailbox-queries'
import type { FilterAction } from './use-filter-actions'
import type { InboxNavigation } from './use-inbox-sections'
import type { useMailboxRows } from './use-mailbox-rows'
import { NO_THREAD_IDS } from './use-mailbox-rows'

export function MailPanes({
  title,
  view,
  accountId,
  mailSearch,
  mailbox,
  inbox,
  ids,
  selectedId,
  notification,
  onSelect,
  move,
  readerToolbar,
  getFilterActions,
  reader,
}: {
  title: string
  view: View
  accountId: string | null
  mailSearch: ReturnType<typeof useMailSearch>
  mailbox: ReturnType<typeof useMailboxRows>
  inbox?: InboxNavigation
  ids: readonly string[] | undefined
  selectedId: string | null
  notification: ThreadSummary | null
  onSelect: (id: string) => void
  move: (delta: number) => void
  readerToolbar: ReactNode
  getFilterActions: (thread: ThreadSummary) => FilterAction[]
  reader: ReactNode
}) {
  const { search, filterText, runSearch } = mailSearch
  const { query, searchRows } = mailbox
  const inboxReady = useReplicaSelector(inbox ? query : null, ({ data }) => data !== undefined)
  const senderAddress = useReplicaSelector(inbox?.senderId ? query : null, ({ data }) =>
    inbox?.senderId ? data?.inbox?.cards.get(inbox.senderId)?.address : undefined,
  )
  const ready = inbox ? inboxReady : ids !== undefined
  const addresses = useReplicaSelector(
    accountsQuery(),
    ({ data }) => data?.map(({ address }) => address.toLowerCase()),
    (left, right) => shareReply(left, right) === left,
  )
  const self = useMemo(() => new Set(addresses), [addresses])
  return (
    <ResizablePanelGroup orientation="horizontal" className="h-full">
      <ResizablePanel defaultSize="40%" minSize="25%" maxSize="60%">
        <div className="flex h-full flex-col">
          <header className="app-drag app-toolbar gap-2 px-3.5">
            <h2
              data-mailbox-heading
              tabIndex={-1}
              className="truncate text-[15px] font-semibold tracking-tight"
            >
              {title}
            </h2>
            {!search && view.kind === 'inbox' && <InboxCount accountId={accountId} />}
            <SearchInput mailSearch={mailSearch} move={move} />
          </header>
          {search
            ? search.failed && (
                <RefreshError retry={() => void runSearch(search.text)} retryLabel="Retry search">
                  Could not search all mail
                </RefreshError>
              )
            : ready && <ThreadQueryError query={query} />}
          {inbox?.senderId != null && (
            <div className="flex items-center gap-2 border-b px-3 py-1">
              <Button variant="outline" size="sm" onClick={() => inbox.openSender(null)}>
                Back to Inbox
              </Button>
              <span className="truncate text-xs">{senderAddress}</span>
            </div>
          )}
          <div className="min-h-0 flex-1">
            <ThreadList
              ids={ids ?? NO_THREAD_IDS}
              query={query}
              inbox={inbox}
              fallbackRows={searchRows?.summaries}
              notification={notification}
              selectedId={selectedId}
              onSelect={onSelect}
              onMove={move}
              getFilterActions={getFilterActions}
              self={self}
              matchSnippets={searchRows?.snippets}
              empty={
                !ready ? (
                  search ? (
                    !search.failed && <MailLoading label="Searching mail" />
                  ) : (
                    <ThreadQueryError query={query} initial />
                  )
                ) : search || filterText.trim() ? (
                  <MailState icon={Search} title="No matching threads">
                    {search
                      ? 'Try a different search.'
                      : 'Press Enter to search your full mail history.'}
                  </MailState>
                ) : inbox?.senderId ? (
                  <MailState icon={Inbox} title="No new Threads from this Sender" />
                ) : view.kind === 'inbox' ? (
                  <MailState icon={Inbox} title="Inbox is clear">
                    New mail will appear here.
                  </MailState>
                ) : (
                  <MailState
                    icon={view.kind === 'bucket' ? Layers : Inbox}
                    title="No threads here"
                  />
                )
              }
            />
          </div>
        </div>
      </ResizablePanel>
      <ResizableHandle />
      <ResizablePanel defaultSize="60%" minSize="35%">
        <div className="flex h-full flex-col">
          {readerToolbar}
          {reader}
        </div>
      </ResizablePanel>
    </ResizablePanelGroup>
  )
}

function InboxCount({ accountId }: { accountId: string | null }) {
  const count = useReplicaSelector(countsQuery(accountId), ({ data }) => data?.inbox ?? 0)
  return count > 0 ? (
    <span className="text-xs text-muted-foreground tabular-nums">{count.toLocaleString()}</span>
  ) : null
}

function ThreadQueryError({
  query,
  initial = false,
}: {
  query: MailboxThreadQuery | null
  initial?: boolean
}) {
  const failed = useReplicaSelector(query, queryFailed)
  if (failed)
    return (
      <RefreshError
        retry={() => {
          if (query) void replicaStoreFor(getAmc()).refresh(query)
        }}
      >
        Could not load threads
      </RefreshError>
    )
  return initial ? <MailLoading label="Loading mail" /> : null
}

function RefreshError({
  children,
  retry,
  retryLabel = 'Retry',
}: {
  children: ReactNode
  retry: () => void
  retryLabel?: string
}) {
  return (
    <div className="flex shrink-0 items-center justify-between gap-2 border-b px-3 py-1">
      <p role="alert" className="truncate text-xs text-destructive">
        {children}
      </p>
      <Button variant="outline" size="sm" className="shrink-0" onClick={retry}>
        {retryLabel}
      </Button>
    </div>
  )
}

export const MailReader = memo(function MailReader({
  engineUrl,
  selectedId,
  selectedAccountId,
  accountId,
  snoozeEnabled,
  scrollRef,
}: {
  engineUrl: string | null
  selectedId: string | undefined
  selectedAccountId: string | undefined
  accountId: string | null
  snoozeEnabled: boolean
  scrollRef: React.RefObject<HTMLDivElement | null>
}) {
  const query = selectedThreadQuery(
    engineUrl,
    selectedId !== undefined && selectedAccountId !== undefined
      ? { id: selectedId, accountId: selectedAccountId }
      : undefined,
  )
  const { data, failed } = useReplicaSelector(
    query,
    (snapshot) => ({ data: snapshot.data, failed: queryFailed(snapshot) }),
    (left, right) => left.data === right.data && left.failed === right.failed,
  )
  const refresh = () => {
    if (query) void replicaStoreFor(getAmc()).refresh(query)
  }
  const labels = useReplicaSelector(labelsQuery(accountId), ({ data }) => data)
  const labelNames = useMemo(() => new Map(labels?.map(({ id, name }) => [id, name])), [labels])
  return (
    <>
      {data && failed && <RefreshError retry={refresh}>Could not refresh this thread</RefreshError>}
      <div className="min-h-0 flex-1">
        <ThreadView
          data={data ?? null}
          loading={query !== null && data === undefined && !failed}
          unavailable={query !== null && (failed || data === null)}
          onRetry={refresh}
          snoozeEnabled={snoozeEnabled}
          labelNames={labelNames}
          scrollRef={scrollRef}
        />
      </div>
    </>
  )
})
