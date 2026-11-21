import type {
  ComposeDraft,
  ComposeStart,
  OutboxItem,
  SearchHit,
  ThreadSummary,
} from '@amc/protocol'
import { Forward, Loader2, Reply, ReplyAll, Search, SquarePen, X } from 'lucide-react'
import { useCallback, useEffect, useMemo, useRef, useState } from 'react'
import { toast } from 'sonner'
import type { Counts, ThreadWithMessages, View } from '../../shared/api'
import { AppSidebar, systemViews } from './components/app-sidebar'
import { CommandPalette } from './components/command-palette'
import { DraftsView, OutboxView } from './components/compose-views'
import { Composer } from './components/composer'
import { OrganisePicker, OrganiseToolbar, useOrganise } from './components/organise'
import { PairScreen } from './components/pair-screen'
import { ThreadList } from './components/thread-list'
import { ThreadView } from './components/thread-view'
import { Button } from './components/ui/button'
import { ResizableHandle, ResizablePanel, ResizablePanelGroup } from './components/ui/resizable'
import { SidebarInset, SidebarProvider } from './components/ui/sidebar'
import { Toaster } from './components/ui/sonner'
import { TooltipProvider } from './components/ui/tooltip'
import { useReplica, useSyncStatus } from './hooks/use-amc'
import { useHotkeys } from './hooks/use-hotkeys'
import { useTheme } from './hooks/use-theme'

const INBOX: View = { kind: 'inbox' }
const NO_COUNTS: Counts = { inbox: 0, inboxUnread: 0, starred: 0, drafts: 0 }

export function App() {
  const status = useSyncStatus()
  useTheme()
  if (!status) return null
  return (
    <TooltipProvider delayDuration={400}>
      {status.phase === 'unpaired' ? (
        <PairScreen savedEngineUrl={status.engineUrl} recoveryMessage={status.error} />
      ) : (
        <MailApp />
      )}
      <Toaster position="bottom-center" />
    </TooltipProvider>
  )
}

type SearchState = { text: string; hits: SearchHit[] | null; loading: boolean } | null

function MailApp() {
  const status = useSyncStatus()
  const { theme, setTheme } = useTheme()
  const [accountId, setAccountId] = useState<string | null>(null)
  const snoozeEnabled = status?.snoozeEnabled === true
  const [selectedView, setView] = useState<View>(INBOX)
  const view = !snoozeEnabled && selectedView.kind === 'snoozed' ? INBOX : selectedView
  useEffect(() => {
    if (view !== selectedView) setView(view)
  }, [view, selectedView])
  const [selectedId, setSelectedId] = useState<string | null>(null)
  const [paletteOpen, setPaletteOpen] = useState(false)
  const [filterText, setFilterText] = useState('')
  const [search, setSearch] = useState<SearchState>(null)
  const paletteInvoker = useRef<HTMLElement | null>(null)
  const [draft, setDraft] = useState<ComposeDraft | null>(null)
  const [openingComposer, setOpeningComposer] = useState(false)
  const opening = useRef(false)
  const [minimised, setMinimised] = useState<{ id: string; subject: string } | null>(null)
  const searchInput = useRef<HTMLInputElement>(null)
  const readerScroll = useRef<HTMLDivElement>(null)

  const accounts = useReplica(() => window.amc.accounts(), [], [])
  const labels = useReplica(() => window.amc.labels(accountId), [accountId], [])
  const counts = useReplica(() => window.amc.counts(accountId), [accountId], NO_COUNTS)
  const viewThreads = useReplica(
    () => (view.kind === 'outbox' ? Promise.resolve([]) : window.amc.threads({ view, accountId })),
    [view, accountId],
    [] as ThreadSummary[],
  )
  const filtered = useReplica(
    () => (filterText.trim() ? window.amc.filter(filterText, accountId) : Promise.resolve(null)),
    [filterText, accountId],
    null as ThreadSummary[] | null,
  )
  const thread = useReplica(
    () => (selectedId ? window.amc.thread(selectedId) : Promise.resolve(null)),
    [selectedId],
    null as ThreadWithMessages | null,
  )

  const self = useMemo(() => new Set(accounts.map((a) => a.address.toLowerCase())), [accounts])
  const labelNames = useMemo(() => new Map(labels.map((l) => [l.id, l.name])), [labels])
  const searchSummaries = useReplica(
    () =>
      search?.hits ? window.amc.summaries(search.hits.map((hit) => hit.id)) : Promise.resolve([]),
    [search?.hits],
    [] as ThreadSummary[],
  )
  const searchThreads = useMemo(() => {
    if (!search?.hits) return null
    const byId = new Map(searchSummaries.map((summary) => [summary.id, summary]))
    return search.hits.map((hit) => byId.get(hit.id) ?? hit)
  }, [search?.hits, searchSummaries])
  const threads: ThreadSummary[] = searchThreads ?? filtered ?? viewThreads
  const selected = threads.find((item) => item.id === selectedId)
  const activeThread = selected && thread?.thread.id === selectedId ? thread : null
  const organiseAccountId = selected?.accountId ?? accountId
  const canUndoOrganise = accounts.some(
    (account) =>
      account.kind === 'gmail' && (!organiseAccountId || account.id === organiseAccountId),
  )
  const canOrganise =
    canUndoOrganise && activeThread?.messages.length === activeThread?.thread.messageCount
  const organise = useOrganise(canOrganise ? (activeThread?.thread ?? null) : null, snoozeEnabled)
  const organisePicker =
    canOrganise && organise.picker?.thread.id === activeThread?.thread.id ? organise.picker : null
  const matchSnippets = useMemo(
    () => (search?.hits ? new Map(search.hits.map((h) => [h.id, h.matchSnippet])) : undefined),
    [search],
  )

  // Keep a selection whenever there is something to select.
  useEffect(() => {
    if (threads.length === 0) {
      setSelectedId(null)
      return
    }
    if (!selectedId || !threads.some((t) => t.id === selectedId))
      setSelectedId(threads[0]?.id ?? null)
  }, [threads, selectedId])

  const title = search
    ? `Search: ${search.text}`
    : view.kind === 'label'
      ? (labelNames.get(view.labelId) ?? 'Label')
      : (systemViews(snoozeEnabled).find((v) => v.view.kind === view.kind)?.title ?? 'Mail')

  const goTo = useCallback((next: View) => {
    setSearch(null)
    setFilterText('')
    setView(next)
    setSelectedId(null)
  }, [])

  const runSearch = useCallback(
    async (text: string) => {
      if (!text) return
      setSearch({ text, hits: null, loading: true })
      try {
        const hits = await window.amc.search(text, accountId)
        setSearch({ text, hits, loading: false })
        setSelectedId(hits[0]?.id ?? null)
      } catch {
        setSearch({ text, hits: [], loading: false })
      }
    },
    [accountId],
  )

  const clearSearch = () => {
    setSearch(null)
    setFilterText('')
    searchInput.current?.blur()
  }

  const move = (delta: number) => {
    if (threads.length === 0) return
    const index = Math.max(
      0,
      threads.findIndex((t) => t.id === selectedId),
    )
    const next = threads[Math.min(threads.length - 1, Math.max(0, index + delta))]
    if (next) setSelectedId(next.id)
  }

  const ownView = !search && (view.kind === 'drafts' || view.kind === 'outbox')
  const openDraft = async (id: string) => {
    if (opening.current || draft) return
    opening.current = true
    setOpeningComposer(true)
    try {
      setDraft(await window.amc.composeDraft(id))
      setMinimised(null)
    } catch (cause) {
      toast.error((cause as Error).message)
    } finally {
      opening.current = false
      setOpeningComposer(false)
    }
  }

  const startCompose = async (mode: ComposeStart['mode']) => {
    if (
      opening.current ||
      draft ||
      (mode !== 'new' && (!thread || thread.thread.id !== selectedId))
    )
      return
    if (mode === 'new' && minimised) return openDraft(minimised.id)
    const from = mode !== 'new' ? thread?.thread.accountId : (accountId ?? accounts[0]?.id)
    if (!from) {
      toast.error('Add an Account before composing.')
      return
    }
    opening.current = true
    setOpeningComposer(true)
    try {
      setDraft(
        await window.amc.startCompose({
          mode,
          accountId: from,
          threadId: mode === 'new' ? undefined : (selectedId ?? undefined),
        }),
      )
    } catch (cause) {
      toast.error((cause as Error).message)
    } finally {
      opening.current = false
      setOpeningComposer(false)
    }
  }

  const queued = (item: OutboxItem) => {
    setDraft(null)
    const remaining = item.undoRemainingMs ?? 0
    const scheduled = item.sendAt > item.undoUntil
    if (item.status !== 'queued') {
      toast.info(item.status === 'sent' ? 'Message sent' : 'Check the Outbox for delivery status')
      return
    }
    toast(scheduled ? 'Send scheduled' : 'Message queued', {
      duration: remaining || 3000,
      action: remaining
        ? {
            label: 'Undo',
            onClick: () => {
              void window.amc
                .cancelSend(item.id)
                .then(async () => {
                  setMinimised({ id: item.draftId, subject: item.subject })
                  toast.success('Send cancelled. Draft saved.')
                })
                .catch((cause: Error) => toast.error(cause.message))
            },
          }
        : undefined,
    })
  }

  const dark = document.documentElement.classList.contains('dark')
  useHotkeys(
    {
      ...Object.fromEntries(
        Object.entries(canUndoOrganise ? organise.shortcuts : {}).map(([key, run]) => [
          key,
          (event: KeyboardEvent) => {
            if (!event.repeat) run()
          },
        ]),
      ),
      c: () => void startCompose('new'),
      r: () => {
        if (!ownView) void startCompose('reply')
      },
      a: () => {
        if (!ownView) void startCompose('reply-all')
      },
      f: () => {
        if (!ownView) void startCompose('forward')
      },
      'g o': () => goTo({ kind: 'outbox' }),
      j: () => move(1),
      arrowdown: () => move(1),
      k: () => move(-1),
      arrowup: () => move(-1),
      space: () =>
        readerScroll.current?.scrollBy({
          top: readerScroll.current.clientHeight * 0.8,
          behavior: 'smooth',
        }),
      '/': () => searchInput.current?.focus(),
      'mod+f': () => searchInput.current?.focus(),
      'mod+k': () => {
        paletteInvoker.current =
          document.activeElement instanceof HTMLElement ? document.activeElement : null
        setPaletteOpen(true)
      },
      escape: () => clearSearch(),
      'g i': () => goTo({ kind: 'inbox' }),
      'g u': () => goTo({ kind: 'unread' }),
      'g s': () => goTo({ kind: 'starred' }),
      'g d': () => goTo({ kind: 'drafts' }),
      'g t': () => goTo({ kind: 'sent' }),
      'g a': () => goTo({ kind: 'all' }),
      ...(snoozeEnabled ? { 'g h': () => goTo({ kind: 'snoozed' }) } : {}),
      'g x': () => goTo({ kind: 'trash' }),
      'mod+0': () => setAccountId(null),
      ...Object.fromEntries(
        accounts.slice(0, 9).map((a, i) => [`mod+${i + 1}`, () => setAccountId(a.id)]),
      ),
    },
    !draft && !paletteOpen && !organisePicker,
  )

  return (
    <SidebarProvider
      className="h-full"
      style={{ '--sidebar-width': '15rem' } as React.CSSProperties}
    >
      <AppSidebar
        accounts={accounts}
        accountId={accountId}
        onAccount={(id) => {
          setAccountId(id)
          setSelectedId(null)
        }}
        view={view}
        onView={goTo}
        onCompose={() => void startCompose('new')}
        composing={openingComposer}
        counts={counts}
        labels={labels}
        status={status}
      />
      <SidebarInset className="overflow-hidden">
        {view.kind === 'drafts' && !search ? (
          <DraftsView accountId={accountId} onOpen={(id) => void openDraft(id)} />
        ) : view.kind === 'outbox' && !search ? (
          <OutboxView
            accountId={accountId}
            onRestore={(id) => void openDraft(id)}
            onThread={(id) => {
              goTo({ kind: 'sent' })
              setSelectedId(id)
              void window.amc.syncNow()
            }}
          />
        ) : (
          <ResizablePanelGroup orientation="horizontal" className="h-full">
            <ResizablePanel defaultSize="40%" minSize="25%" maxSize="60%">
              <div className="flex h-full flex-col">
                <header className="app-drag flex h-12 shrink-0 items-center gap-2 border-b px-4">
                  <h2 className="truncate text-sm font-semibold">{title}</h2>
                  {!search && view.kind === 'inbox' && counts.inbox > 0 && (
                    <span className="text-xs text-muted-foreground tabular-nums">
                      {counts.inbox.toLocaleString()}
                    </span>
                  )}
                  <div className="relative ml-auto w-56">
                    {search?.loading ? (
                      <Loader2 className="absolute top-1/2 left-2.5 size-3.5 -translate-y-1/2 animate-spin text-muted-foreground" />
                    ) : (
                      <Search className="absolute top-1/2 left-2.5 size-3.5 -translate-y-1/2 text-muted-foreground" />
                    )}
                    <input
                      ref={searchInput}
                      value={search ? search.text : filterText}
                      onChange={(e) => {
                        setSearch(null)
                        setFilterText(e.target.value)
                      }}
                      onKeyDown={(e) => {
                        if (e.key === 'Enter') void runSearch((search?.text ?? filterText).trim())
                        if (e.key === 'ArrowDown') {
                          e.preventDefault()
                          searchInput.current?.blur()
                          move(1)
                        }
                      }}
                      placeholder="Filter · ↵ searches everything"
                      className="h-7 w-full rounded-md border border-transparent bg-muted pr-7 pl-8 text-xs outline-none placeholder:text-muted-foreground focus:border-ring/50 focus:bg-background"
                    />
                    {(search || filterText) && (
                      <button
                        type="button"
                        onClick={clearSearch}
                        className="absolute top-1/2 right-2 -translate-y-1/2 text-muted-foreground hover:text-foreground"
                      >
                        <X className="size-3.5" />
                      </button>
                    )}
                  </div>
                </header>
                <div className="min-h-0 flex-1">
                  <ThreadList
                    threads={threads}
                    selectedId={selectedId}
                    onSelect={setSelectedId}
                    self={self}
                    matchSnippets={matchSnippets}
                    empty={
                      search?.loading
                        ? 'Searching your entire history…'
                        : search
                          ? 'Nothing found.'
                          : filterText
                            ? 'No matches here. Press ↵ to search all mail.'
                            : view.kind === 'inbox'
                              ? 'Inbox zero.'
                              : 'Nothing here.'
                    }
                  />
                </div>
              </div>
            </ResizablePanel>
            <ResizableHandle />
            <ResizablePanel defaultSize="60%" minSize="35%">
              <div className="flex h-full flex-col">
                <div className="app-drag flex h-12 shrink-0 items-center gap-1 border-b px-3">
                  {organise.controls.length > 0 && <OrganiseToolbar controls={organise.controls} />}
                  {activeThread && (
                    <>
                      <Button
                        size="icon-sm"
                        variant="ghost"
                        title="Reply (R)"
                        aria-label="Reply"
                        disabled={openingComposer}
                        onClick={() => void startCompose('reply')}
                      >
                        <Reply />
                      </Button>
                      <Button
                        size="icon-sm"
                        variant="ghost"
                        title="Reply all (A)"
                        aria-label="Reply all"
                        disabled={openingComposer}
                        onClick={() => void startCompose('reply-all')}
                      >
                        <ReplyAll />
                      </Button>
                      <Button
                        size="icon-sm"
                        variant="ghost"
                        title="Forward (F)"
                        aria-label="Forward"
                        disabled={openingComposer}
                        onClick={() => void startCompose('forward')}
                      >
                        <Forward />
                      </Button>
                    </>
                  )}
                </div>
                <div className="min-h-0 flex-1">
                  <ThreadView
                    data={activeThread}
                    snoozeEnabled={snoozeEnabled}
                    labelNames={labelNames}
                    scrollRef={readerScroll}
                  />
                </div>
              </div>
            </ResizablePanel>
          </ResizablePanelGroup>
        )}
        {minimised && !draft && (
          <Button
            className="fixed right-4 bottom-4 z-20 max-w-64 shadow-md"
            variant="secondary"
            onClick={() => void openDraft(minimised.id)}
          >
            <SquarePen /> <span className="truncate">{minimised.subject || 'Resume draft'}</span>
          </Button>
        )}
        {draft && (
          <Composer
            key={draft.id}
            draft={draft}
            accounts={accounts}
            onQueued={queued}
            onMinimise={(subject) => {
              setMinimised({ id: draft.id, subject })
              setDraft(null)
            }}
          />
        )}
      </SidebarInset>
      {organisePicker && (
        <OrganisePicker
          picker={organisePicker}
          labels={labels}
          onClose={() => organise.setPicker(null)}
          focusFallback={() => searchInput.current?.focus()}
          run={organise.run}
        />
      )}
      <CommandPalette
        open={paletteOpen}
        onOpenChange={setPaletteOpen}
        accounts={accounts}
        labels={labels}
        onView={goTo}
        onAccount={setAccountId}
        onSearch={(text) => void runSearch(text)}
        onToggleTheme={() =>
          setTheme(dark ? 'light' : theme === 'system' && !dark ? 'dark' : dark ? 'light' : 'dark')
        }
        dark={dark}
        snoozeEnabled={snoozeEnabled}
        organise={organise.controls.map((control) => ({
          ...control,
          run: () => control.run(paletteInvoker.current ?? undefined),
        }))}
        undo={canUndoOrganise ? organise.undo : undefined}
      />
    </SidebarProvider>
  )
}
