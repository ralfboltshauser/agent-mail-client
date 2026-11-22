import { Inbox, Layers, Search } from 'lucide-react'
import type { ReactNode } from 'react'
import { MailLoading, MailState } from '@/components/mail-state'
import { ThreadList } from '@/components/thread-list'
import { ThreadView } from '@/components/thread-view'
import { Button } from '@/components/ui/button'
import { ResizableHandle, ResizablePanel, ResizablePanelGroup } from '@/components/ui/resizable'
import type { View } from '../../../../shared/api'
import { SearchInput } from '../search/search-input'
import type { useMailSearch } from '../search/use-mail-search'
import type { useThreadSelection } from './use-mailbox-navigation'
import type { useMailboxRows } from './use-mailbox-rows'
import { NO_THREADS } from './use-mailbox-rows'

export function MailPanes({
  title,
  view,
  inboxCount,
  mailSearch,
  mailbox,
  selection,
  self,
  readerToolbar,
  reader,
}: {
  title: string
  view: View
  inboxCount: number
  mailSearch: ReturnType<typeof useMailSearch>
  mailbox: ReturnType<typeof useMailboxRows>
  selection: ReturnType<typeof useThreadSelection>
  self: Set<string>
  readerToolbar: ReactNode
  reader: ReactNode
}) {
  const { search, filterText, runSearch } = mailSearch
  const { threads, selected, select, move } = selection
  const { list, rows, matchSnippets } = mailbox
  const error = search
    ? search.failed && 'Could not search all mail'
    : list.failed && 'Could not load threads'
  const retry = search ? () => void runSearch(search.text) : list.refresh
  return (
    <ResizablePanelGroup orientation="horizontal" className="h-full">
      <ResizablePanel defaultSize="40%" minSize="25%" maxSize="60%">
        <div className="flex h-full flex-col">
          <header className="app-drag app-toolbar gap-2 px-3.5">
            <h2 className="truncate text-[15px] font-semibold tracking-tight">{title}</h2>
            {!search && view.kind === 'inbox' && inboxCount > 0 && (
              <span className="text-xs text-muted-foreground tabular-nums">
                {inboxCount.toLocaleString()}
              </span>
            )}
            <SearchInput mailSearch={mailSearch} move={move} />
          </header>
          {error && (
            <RefreshError retry={retry} retryLabel={search ? 'Retry search' : 'Retry'}>
              {error}
            </RefreshError>
          )}
          <div className="min-h-0 flex-1">
            <ThreadList
              threads={threads ?? NO_THREADS}
              selectedId={selected?.id ?? null}
              onSelect={select}
              onMove={move}
              self={self}
              matchSnippets={matchSnippets}
              empty={
                rows === undefined ? (
                  error ? null : (
                    <MailLoading label={search ? 'Searching mail' : 'Loading mail'} />
                  )
                ) : search || filterText.trim() ? (
                  <MailState icon={Search} title="No matching threads">
                    {search
                      ? 'Try a different search.'
                      : 'Press Enter to search your full mail history.'}
                  </MailState>
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

export function MailReader({
  failed,
  ...props
}: React.ComponentProps<typeof ThreadView> & { failed: boolean }) {
  return (
    <>
      {props.data && failed && props.onRetry && (
        <RefreshError retry={props.onRetry}>Could not refresh this thread</RefreshError>
      )}
      <div className="min-h-0 flex-1">
        <ThreadView {...props} />
      </div>
    </>
  )
}
