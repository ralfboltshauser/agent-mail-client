import type { ThreadSummary } from '@amc/protocol'
import { Inbox, Layers, Search } from 'lucide-react'
import { memo, type ReactNode, type RefObject, useMemo } from 'react'
import { MailLoading, MailState } from '@/components/mail-state'
import { ThreadList } from '@/components/thread-list'
import { Button } from '@/components/ui/button'
import { ResizableHandle, ResizablePanel, ResizablePanelGroup } from '@/components/ui/resizable'
import { replicaStoreFor } from '@/data/replica-store'
import { shareReply } from '@/data/share-reply'
import { useReplicaSelector } from '@/hooks/use-amc'
import { getAmc } from '@/lib/amc'
import { cn } from '@/lib/utils'
import type { View } from '../../../../shared/api'
import { SearchInput } from '../search/search-input'
import type { useMailSearch } from '../search/use-mail-search'
import { ReaderPresentation } from '../thread-reader/reader-presentation'
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
  onOpenThread,
  move,
  readerToolbar,
  expanded,
  compact,
  listRef,
  readerRef,
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
  onOpenThread: () => void
  move: (delta: number) => void
  readerToolbar: ReactNode
  expanded: boolean
  compact: boolean
  listRef: RefObject<HTMLDivElement | null>
  readerRef: RefObject<HTMLDivElement | null>
  getFilterActions: (thread: ThreadSummary) => FilterAction[]
  reader: ReactNode
}) {
  const { search, filter, retrySearch, loadMore } = mailSearch
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
  const scope = useReplicaSelector(
    accountId ? accountsQuery() : null,
    ({ data }) => data?.find(({ id }) => id === accountId)?.address,
  )
  return (
    <ResizablePanelGroup orientation="horizontal" className="relative h-full">
      {/* Keep the split and the scroll container mounted across the breakpoint. */}
      <ResizablePanel
        defaultSize="40%"
        minSize="25%"
        maxSize="60%"
        style={compact ? { overflow: 'visible' } : undefined}
      >
        <div
          ref={listRef}
          inert={expanded}
          className={cn(
            '@container flex h-full flex-col',
            compact && 'absolute inset-0',
            expanded && 'invisible',
          )}
        >
          <header className="app-drag app-toolbar relative gap-2 px-3.5 @max-[250px]:grid @max-[250px]:h-auto @max-[250px]:grid-cols-[minmax(0,1fr)_auto] @max-[250px]:gap-y-1.5 @max-[250px]:py-2">
            <h2
              data-mailbox-heading
              tabIndex={-1}
              className="min-w-0 shrink truncate text-[15px] font-semibold tracking-tight"
            >
              {title}
            </h2>
            {!search && view.kind === 'inbox' && <InboxCount accountId={accountId} />}
            <SearchInput
              mailSearch={mailSearch}
              mailboxTitle={title}
              scope={scope ?? (accountId ? 'Selected account' : 'All accounts')}
              focusResults={() => {
                const results = listRef.current?.querySelector<HTMLElement>('[role="listbox"]')
                if (!results) return
                results.focus()
                move(1)
              }}
            />
          </header>
          {search
            ? search.failed && (
                <RefreshError
                  retry={() => void retrySearch()}
                  retryLabel="Retry search"
                  failure={search.failure}
                >
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
              onOpenThread={onOpenThread}
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
                ) : search || filter ? (
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
          {search?.hasMore && !search.failed && (
            <div className="flex justify-center border-t p-2">
              <Button
                variant="outline"
                size="sm"
                disabled={search.loading}
                onClick={() => void loadMore()}
              >
                {search.loading ? 'Loading more…' : 'Load more results'}
              </Button>
            </div>
          )}
        </div>
      </ResizablePanel>
      <ResizableHandle
        disabled={expanded || compact}
        className={compact ? 'hidden' : expanded ? 'invisible' : undefined}
      />
      <ResizablePanel defaultSize="60%" minSize="35%">
        {(!compact || expanded) && (
          <div
            ref={readerRef}
            tabIndex={-1}
            data-focus-reader={expanded || undefined}
            className={cn(
              'flex h-full flex-col outline-none',
              expanded && 'fixed inset-0 z-[15] bg-background',
            )}
          >
            {readerToolbar}
            {reader}
          </div>
        )}
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
  const failure = useReplicaSelector(query, (snapshot) => snapshot.failure)
  if (failure)
    return (
      <RefreshError
        failure={failure}
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
  failure,
}: {
  children: ReactNode
  retry: () => void
  retryLabel?: string
  failure?: string
}) {
  return (
    <div className="flex shrink-0 items-center justify-between gap-2 border-b px-3 py-1">
      <div role="alert" className="min-w-0 text-xs text-destructive">
        <p>{children}</p>
        {failure && <p className="select-text break-all text-muted-foreground">{failure}</p>}
      </div>
      <Button variant="outline" size="sm" className="shrink-0" onClick={retry}>
        {retryLabel}
      </Button>
    </div>
  )
}

export const MailReader = memo(function MailReader({
  engineUrl,
  scope,
  selectedId,
  selectedAccountId,
  accountId,
  snoozeEnabled,
  readerRef,
  scrollRef,
  expanded,
  onEditDraft,
  draftEditingDisabled,
}: {
  engineUrl: string | null
  scope: string
  selectedId: string | undefined
  selectedAccountId: string | undefined
  accountId: string | null
  snoozeEnabled: boolean
  readerRef: RefObject<HTMLDivElement | null>
  scrollRef: React.RefObject<HTMLDivElement | null>
  expanded: boolean
  onEditDraft: (messageId: string, imapRevision?: string) => void
  draftEditingDisabled: boolean
}) {
  const query = selectedThreadQuery(
    engineUrl,
    selectedId !== undefined && selectedAccountId !== undefined
      ? { id: selectedId, accountId: selectedAccountId }
      : undefined,
  )
  const { data, failed, failure } = useReplicaSelector(
    query,
    (snapshot) => ({
      data: snapshot.data,
      failed: queryFailed(snapshot),
      failure: snapshot.failure,
    }),
    (left, right) =>
      left.data === right.data && left.failed === right.failed && left.failure === right.failure,
  )
  const refresh = () => {
    if (query) void replicaStoreFor(getAmc()).refresh(query)
  }
  const labels = useReplicaSelector(labelsQuery(accountId), ({ data }) => data)
  const labelNames = useMemo(() => new Map(labels?.map(({ id, name }) => [id, name])), [labels])
  return (
    <>
      {failed && (
        <RefreshError retry={refresh} failure={failure}>
          {data ? 'Could not refresh this thread' : 'Could not load this thread'}
        </RefreshError>
      )}
      <ReaderPresentation
        key={JSON.stringify([engineUrl, scope, selectedAccountId])}
        data={data}
        selectedId={selectedId}
        loading={query !== null && data === undefined && !failed}
        unavailable={query !== null && (failed || data === null)}
        onRetry={refresh}
        snoozeEnabled={snoozeEnabled}
        labelNames={labelNames}
        scrollRef={scrollRef}
        readerRef={readerRef}
        expanded={expanded}
        onEditDraft={onEditDraft}
        draftEditingDisabled={draftEditingDisabled}
      />
    </>
  )
})
