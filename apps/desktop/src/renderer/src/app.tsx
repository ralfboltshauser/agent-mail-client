import {
  BUCKETS,
  type Bucket,
  type ComposeDraft,
  type ComposeStart,
  ORIGINAL_DRAFT_LEFT,
  type OutboxItem,
  type SearchHit,
  type ThreadSummary,
} from '@amc/protocol'
import {
  Activity,
  CircleAlert,
  CircleHelp,
  Forward,
  Inbox,
  Layers,
  Loader2,
  Reply,
  ReplyAll,
  Search,
  Settings2,
  SquarePen,
  X,
} from 'lucide-react'
import { useCallback, useEffect, useMemo, useRef, useState } from 'react'
import { toast } from 'sonner'
import { getAmc } from '@/lib/amc'
import type { Counts, SyncStatus, ThreadWithMessages, View } from '../../shared/api'
import { AgentActivity } from './components/agent-activity'
import { AppSidebar, systemViews } from './components/app-sidebar'
import { BucketPicker } from './components/bucket-picker'
import { CommandPalette } from './components/command-palette'
import { DraftsView, OutboxView } from './components/compose-views'
import { Composer } from './components/composer'
import { HandoffDialog } from './components/handoff-dialog'
import { MailLoading, MailState } from './components/mail-state'
import { OrganisePicker, OrganiseToolbar, useOrganise } from './components/organise'
import { PairScreen } from './components/pair-screen'
import { SendSettings } from './components/send-settings'
import { ShortcutsDialog } from './components/shortcuts-dialog'
import { ThreadList } from './components/thread-list'
import { ThreadView } from './components/thread-view'
import { Button } from './components/ui/button'
import { ResizableHandle, ResizablePanel, ResizablePanelGroup } from './components/ui/resizable'
import { SidebarInset, SidebarProvider } from './components/ui/sidebar'
import { Toaster } from './components/ui/sonner'
import { TooltipProvider } from './components/ui/tooltip'
import { useReplica, useReplicaQuery, useSyncStatus } from './hooks/use-amc'
import { useHotkeys } from './hooks/use-hotkeys'
import { useTheme } from './hooks/use-theme'

const INBOX: View = { kind: 'inbox' }
const NO_COUNTS: Counts = { inbox: 0, inboxUnread: 0, starred: 0, drafts: 0, buckets: {} }

export function App() {
  const status = useSyncStatus()
  const { dark, setTheme } = useTheme()
  if (!status) return <MailLoading label="Opening AMC" />
  return (
    <TooltipProvider delayDuration={400}>
      {status.phase === 'unpaired' ? (
        <PairScreen savedEngineUrl={status.engineUrl} recoveryMessage={status.error} />
      ) : (
        <MailApp
          status={status}
          dark={dark}
          onToggleTheme={() => setTheme(dark ? 'light' : 'dark')}
        />
      )}
      <Toaster theme={dark ? 'dark' : 'light'} position="bottom-center" />
    </TooltipProvider>
  )
}

type SearchState = {
  text: string
  hits: SearchHit[] | null
  loading: boolean
  failed?: boolean
} | null

function MailApp({
  status,
  dark,
  onToggleTheme,
}: {
  status: SyncStatus
  dark: boolean
  onToggleTheme: () => void
}) {
  const [accountId, setAccountId] = useState<string | null>(null)
  const snoozeEnabled = status?.snoozeEnabled === true
  const [selectedView, setView] = useState<View>(INBOX)
  const view = !snoozeEnabled && selectedView.kind === 'snoozed' ? INBOX : selectedView
  useEffect(() => {
    if (view !== selectedView) setView(view)
  }, [view, selectedView])
  const [selectedId, setSelectedId] = useState<string | null>(null)
  const [bucketPickerId, setBucketPickerId] = useState<string | null>(null)
  const [paletteOpen, setPaletteOpen] = useState(false)
  const [shortcutsOpen, setShortcutsOpen] = useState(false)
  const [agentOpen, setAgentOpen] = useState(false)
  const [sendSettings, setSendSettings] = useState<number | null>(null)
  const searchRequest = useRef(0)
  const openSendSettings = () => {
    void getAmc()
      .sendSettings()
      .then(({ undoSendSeconds }) => setSendSettings(undoSendSeconds))
      .catch((cause: Error) =>
        toast.error('Could not open settings', { description: cause.message }),
      )
  }
  const [filterText, setFilterText] = useState('')
  const [search, setSearch] = useState<SearchState>(null)
  const paletteInvoker = useRef<HTMLElement | null>(null)
  const [draft, setDraft] = useState<ComposeDraft | null>(null)
  const [handoffThread, setHandoffThread] = useState<string | null>(null)
  const [openingComposer, setOpeningComposer] = useState(false)
  const opening = useRef(false)
  const [minimised, setMinimised] = useState<{ id: string; subject: string } | null>(null)
  const searchInput = useRef<HTMLInputElement>(null)
  const readerScroll = useRef<HTMLDivElement>(null)

  const accounts = useReplica(() => getAmc().accounts(), [], [])
  const labels = useReplica(() => getAmc().labels(accountId), [accountId], [])
  const counts = useReplica(() => getAmc().counts(accountId), [accountId], NO_COUNTS)
  const listQuery = useReplicaQuery(
    () => (view.kind === 'outbox' ? Promise.resolve([]) : getAmc().threads({ view, accountId })),
    [view, accountId],
    null as ThreadSummary[] | null,
  )
  const filterQuery = useReplicaQuery(
    () => (filterText.trim() ? getAmc().filter(filterText, accountId) : Promise.resolve(null)),
    [filterText, accountId],
    null as ThreadSummary[] | null,
  )
  const threadQuery = useReplicaQuery(
    async () => ({ id: selectedId, data: selectedId ? await getAmc().thread(selectedId) : null }),
    [selectedId],
    null as { id: string | null; data: ThreadWithMessages | null } | null,
  )
  const viewThreads = listQuery.value
  const filtered = filterQuery.value
  const thread = threadQuery.value?.data

  const self = useMemo(() => new Set(accounts.map((a) => a.address.toLowerCase())), [accounts])
  const labelNames = useMemo(() => new Map(labels.map((l) => [l.id, l.name])), [labels])
  const searchSummaries = useReplica(
    () =>
      search?.hits ? getAmc().summaries(search.hits.map((hit) => hit.id)) : Promise.resolve([]),
    [search?.hits],
    [] as ThreadSummary[],
  )
  const searchThreads = useMemo(() => {
    if (!search?.hits) return null
    const byId = new Map(searchSummaries.map((summary) => [summary.id, summary]))
    return search.hits.map((hit) => byId.get(hit.id) ?? hit)
  }, [search?.hits, searchSummaries])
  const threads: ThreadSummary[] = search
    ? (searchThreads ?? [])
    : ((filtered && view.kind === 'bucket'
        ? filtered.filter((item) => item.bucket?.bucket === view.bucket)
        : filtered) ??
      viewThreads ??
      [])
  const activeListQuery = filterText.trim() ? filterQuery : listQuery
  const selected = threads.find((item) => item.id === selectedId)
  const bucketPickerOpen = !!selected && bucketPickerId === selected.id
  const setBucket = async (bucket: Bucket | null) => {
    if (!selected || (selected.bucket?.bucket ?? null) === bucket) return
    setBucketPickerId(null)
    try {
      await getAmc().setBucket({ threadId: selected.id, bucket, reason: 'Set manually' })
    } catch (error) {
      toast.error('Could not move Thread', { description: (error as Error).message })
    }
  }
  const activeThread = selected && thread?.thread.id === selectedId ? thread : null
  const handoff = useReplica(
    async () =>
      selectedId
        ? { threadId: selectedId, active: await getAmc().activeHandoff(selectedId) }
        : null,
    [selectedId, status?.engineUrl, status?.phase],
    null,
  )
  const [inactiveHandoff, setInactiveHandoff] = useState<string | null>(null)
  const [endingHandoff, setEndingHandoff] = useState<string | null>(null)
  const activeHandoff =
    handoff && handoff.threadId === selectedId && handoff.active?.id !== inactiveHandoff
      ? handoff.active
      : null
  useEffect(() => {
    if (!activeHandoff) return
    const timer = setTimeout(
      () => setInactiveHandoff(activeHandoff.id),
      activeHandoff.expiresAt - Date.now(),
    )
    return () => clearTimeout(timer)
  }, [activeHandoff])
  const endHandoff = async (id: string) => {
    setEndingHandoff(id)
    try {
      await getAmc().endHandoff(id)
      setInactiveHandoff(id)
      toast.success('Hand-off ended')
    } catch (error) {
      toast.error('Could not end hand-off', { description: (error as Error).message })
    } finally {
      setEndingHandoff(null)
    }
  }
  const organiseAccountId = selected?.accountId ?? accountId
  const organiseAccount = accounts.find((account) => account.id === organiseAccountId)
  const canUndoOrganise = organiseAccountId ? Boolean(organiseAccount) : accounts.length > 0
  const canOrganise =
    canUndoOrganise && activeThread?.messages.length === activeThread?.thread.messageCount
  const organise = useOrganise(
    canOrganise ? (activeThread?.thread ?? null) : null,
    snoozeEnabled,
    organiseAccount,
    labels,
  )
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
      : view.kind === 'bucket'
        ? view.bucket
        : (systemViews(snoozeEnabled).find((v) => v.view.kind === view.kind)?.title ?? 'Mail')

  const goTo = useCallback((next: View) => {
    searchRequest.current++
    setSearch(null)
    setFilterText('')
    setBucketPickerId(null)
    setView(next)
    setSelectedId(null)
  }, [])

  const runSearch = useCallback(
    async (text: string) => {
      if (!text) return
      const request = ++searchRequest.current
      setSearch({ text, hits: null, loading: true })
      try {
        const hits = await getAmc().search(text, accountId)
        if (request !== searchRequest.current) return
        setSearch({ text, hits, loading: false })
        setSelectedId(hits[0]?.id ?? null)
      } catch {
        if (request === searchRequest.current)
          setSearch({ text, hits: [], loading: false, failed: true })
      }
    },
    [accountId],
  )

  const clearSearch = () => {
    searchRequest.current++
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
      setDraft(await getAmc().composeDraft(id))
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
        await getAmc().startCompose({
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
    if (item.originalDraftLeft) toast.warning(ORIGINAL_DRAFT_LEFT)
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
              void getAmc()
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

  const selectAccount = (id: string | null) => {
    searchRequest.current++
    setSearch(null)
    setSelectedId(null)
    setAccountId(id)
  }
  const rememberFocus = () => {
    paletteInvoker.current =
      document.activeElement instanceof HTMLElement ? document.activeElement : null
  }
  const openPalette = () => {
    rememberFocus()
    setPaletteOpen(true)
  }
  const restoreDialogFocus = (event: Event) => {
    if (paletteInvoker.current?.isConnected && document.activeElement === document.body) {
      event.preventDefault()
      paletteInvoker.current.focus()
    }
  }
  const canHandOff = !ownView && !draft && !openingComposer && !!activeThread
  const handOff = () => {
    if (canHandOff && activeThread) setHandoffThread(activeThread.thread.id)
  }
  const commandActions = [
    {
      name: minimised ? 'Resume draft' : 'Compose message',
      icon: SquarePen,
      shortcut: 'C',
      run: () => void startCompose('new'),
    },
    ...(activeThread && !ownView && !openingComposer
      ? [
          { name: 'Reply', icon: Reply, shortcut: 'R', run: () => void startCompose('reply') },
          {
            name: 'Reply all',
            icon: ReplyAll,
            shortcut: 'A',
            run: () => void startCompose('reply-all'),
          },
          {
            name: 'Forward',
            icon: Forward,
            shortcut: 'F',
            run: () => void startCompose('forward'),
          },
        ]
      : []),
    ...(selected && !ownView
      ? [
          {
            name: 'Choose a Bucket',
            icon: Layers,
            shortcut: 'B',
            run: () => setBucketPickerId(selected.id),
          },
          ...BUCKETS.map((bucket, index) => ({
            name: `Move to Bucket: ${bucket}`,
            icon: Layers,
            shortcut: String(index + 1),
            run: () => void setBucket(bucket),
          })),
          ...(selected.bucket
            ? [{ name: 'Clear Bucket', icon: X, run: () => void setBucket(null) }]
            : []),
        ]
      : []),
    ...(canHandOff ? [{ name: 'Hand off', icon: Forward, shortcut: 'T', run: handOff }] : []),
    ...(activeHandoff && endingHandoff !== activeHandoff.id
      ? [{ name: 'End hand-off', icon: X, run: () => void endHandoff(activeHandoff.id) }]
      : []),
  ]
  const appActions = [
    { name: 'Agent activity', icon: Activity, run: () => setAgentOpen(true) },
    { name: 'Undo send settings', icon: Settings2, run: openSendSettings },
    {
      name: 'Keyboard shortcuts',
      icon: CircleHelp,
      shortcut: '?',
      run: () => setShortcutsOpen(true),
    },
  ]
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
      t: (event) => {
        if (!event.repeat) handOff()
      },
      '?': () => {
        rememberFocus()
        setShortcutsOpen(true)
      },
      'g o': () => goTo({ kind: 'outbox' }),
      b: (event) => {
        if (!event.repeat && selected && !ownView) setBucketPickerId(selected.id)
      },
      ...Object.fromEntries(
        BUCKETS.map((bucket, index) => [
          String(index + 1),
          (event: KeyboardEvent) => {
            if (!event.repeat && !ownView) void setBucket(bucket)
          },
        ]),
      ),
      j: () => move(1),
      arrowdown: () => move(1),
      k: () => move(-1),
      arrowup: () => move(-1),
      space: () =>
        readerScroll.current?.scrollBy({
          top: readerScroll.current.clientHeight * 0.8,
          behavior: matchMedia('(prefers-reduced-motion: reduce)').matches ? 'instant' : 'smooth',
        }),
      '/': () => searchInput.current?.focus(),
      'mod+f': () => searchInput.current?.focus(),
      'mod+k': openPalette,
      escape: () => clearSearch(),
      'g i': () => goTo({ kind: 'inbox' }),
      'g u': () => goTo({ kind: 'unread' }),
      'g s': () => goTo({ kind: 'starred' }),
      'g d': () => goTo({ kind: 'drafts' }),
      'g t': () => goTo({ kind: 'sent' }),
      'g a': () => goTo({ kind: 'all' }),
      ...(snoozeEnabled ? { 'g h': () => goTo({ kind: 'snoozed' }) } : {}),
      'g x': () => goTo({ kind: 'trash' }),
      'mod+0': () => selectAccount(null),
      ...Object.fromEntries(
        accounts.slice(0, 9).map((a, i) => [`mod+${i + 1}`, () => selectAccount(a.id)]),
      ),
    },
    !draft &&
      !paletteOpen &&
      !shortcutsOpen &&
      !agentOpen &&
      sendSettings === null &&
      !handoffThread &&
      !organisePicker &&
      !bucketPickerOpen,
  )

  return (
    <SidebarProvider
      className="h-full"
      style={{ '--sidebar-width': '13.5rem' } as React.CSSProperties}
    >
      <AppSidebar
        accounts={accounts}
        accountId={accountId}
        onAccount={selectAccount}
        view={view}
        onView={goTo}
        onCompose={() => void startCompose('new')}
        onPalette={openPalette}
        onAgent={() => {
          rememberFocus()
          setAgentOpen(true)
        }}
        onShortcuts={() => {
          rememberFocus()
          setShortcutsOpen(true)
        }}
        composing={openingComposer}
        counts={counts}
        labels={labels}
        status={status}
      />
      <SidebarInset className="overflow-hidden">
        {view.kind === 'drafts' && !search ? (
          <DraftsView
            accountId={accountId}
            onOpen={(id) => void openDraft(id)}
            onDiscarded={(id) => setMinimised((current) => (current?.id === id ? null : current))}
          />
        ) : view.kind === 'outbox' && !search ? (
          <OutboxView
            accountId={accountId}
            onRestore={(id) => void openDraft(id)}
            onSettings={() => {
              rememberFocus()
              openSendSettings()
            }}
            onThread={(id) => {
              goTo({ kind: 'sent' })
              setSelectedId(id)
              void getAmc().syncNow()
            }}
          />
        ) : (
          <ResizablePanelGroup orientation="horizontal" className="h-full">
            <ResizablePanel defaultSize="40%" minSize="25%" maxSize="60%">
              <div className="flex h-full flex-col">
                <header className="app-drag app-toolbar gap-2 px-3.5">
                  <h2 className="truncate text-[15px] font-semibold tracking-tight">{title}</h2>
                  {!search && view.kind === 'inbox' && counts.inbox > 0 && (
                    <span className="text-xs text-muted-foreground tabular-nums">
                      {counts.inbox.toLocaleString()}
                    </span>
                  )}
                  <div className="relative ml-auto min-w-20 max-w-52 flex-1">
                    {search?.loading ? (
                      <Loader2 className="absolute top-1/2 left-2.5 size-3.5 -translate-y-1/2 motion-safe:animate-spin text-muted-foreground" />
                    ) : (
                      <Search className="absolute top-1/2 left-2.5 size-3.5 -translate-y-1/2 text-muted-foreground" />
                    )}
                    <input
                      ref={searchInput}
                      aria-label="Filter mail or press Enter to search all mail"
                      value={search ? search.text : filterText}
                      onChange={(e) => {
                        searchRequest.current++
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
                      placeholder="Filter mail"
                      className="h-8 w-full rounded-md border border-transparent bg-muted pr-8 pl-8 text-xs outline-none placeholder:text-muted-foreground focus:border-ring/50 focus:bg-background"
                    />
                    {(search || filterText) && (
                      <button
                        type="button"
                        aria-label="Clear search"
                        onClick={clearSearch}
                        className="absolute top-1/2 right-1 flex size-6 -translate-y-1/2 items-center justify-center rounded-sm text-muted-foreground hover:text-foreground"
                      >
                        <X className="size-3.5" />
                      </button>
                    )}
                    {!search && !filterText && (
                      <kbd className="pointer-events-none absolute top-1/2 right-2 -translate-y-1/2 text-xs text-muted-foreground">
                        /
                      </kbd>
                    )}
                  </div>
                </header>
                <div className="min-h-0 flex-1">
                  {!search && activeListQuery.failed ? (
                    <MailState icon={CircleAlert} title="Could not load threads" error>
                      <Button variant="outline" size="sm" onClick={activeListQuery.refresh}>
                        Retry
                      </Button>
                    </MailState>
                  ) : (
                    <ThreadList
                      threads={threads}
                      selectedId={selectedId}
                      onSelect={setSelectedId}
                      onMove={move}
                      self={self}
                      matchSnippets={matchSnippets}
                      empty={
                        search?.failed ? (
                          <MailState icon={CircleAlert} title="Could not search all mail" error>
                            <p>Check your connection to the Engine and try again.</p>
                            <Button
                              className="mt-2"
                              variant="outline"
                              size="sm"
                              onClick={() => void runSearch(search.text)}
                            >
                              Retry search
                            </Button>
                          </MailState>
                        ) : search?.loading ||
                          (status.phase === 'bootstrapping' && threads.length === 0) ||
                          viewThreads === null ? (
                          <MailLoading
                            label={search?.loading ? 'Searching mail' : 'Loading mail'}
                          />
                        ) : search || filterText ? (
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
                  )}
                </div>
              </div>
            </ResizablePanel>
            <ResizableHandle />
            <ResizablePanel defaultSize="60%" minSize="35%">
              <div className="flex h-full flex-col">
                <div className="app-drag app-toolbar gap-0.5 overflow-x-auto px-3">
                  {organise.controls.length > 0 && <OrganiseToolbar controls={organise.controls} />}
                  {activeThread &&
                    organiseAccount?.kind === 'imap' &&
                    organiseAccount.imapMoves === false && (
                      <span className="text-muted-foreground text-xs">
                        This IMAP server does not support safe moves
                      </span>
                    )}
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
                      <Button
                        size="sm"
                        variant="ghost"
                        title="Hand off (T)"
                        disabled={Boolean(draft) || openingComposer}
                        onClick={() => setHandoffThread(activeThread.thread.id)}
                      >
                        Hand off
                      </Button>
                      {activeHandoff && (
                        <>
                          <span className="text-xs text-muted-foreground">Active hand-off</span>
                          <Button
                            size="sm"
                            variant="ghost"
                            disabled={endingHandoff === activeHandoff.id}
                            onClick={() => void endHandoff(activeHandoff.id)}
                          >
                            End hand-off
                          </Button>
                        </>
                      )}
                    </>
                  )}
                  {selected && (
                    <BucketPicker
                      current={selected.bucket?.bucket ?? null}
                      open={bucketPickerOpen}
                      onOpenChange={(open) => setBucketPickerId(open ? selected.id : null)}
                      onSelect={(bucket) => void setBucket(bucket)}
                    />
                  )}
                </div>
                <div className="min-h-0 flex-1">
                  <ThreadView
                    data={activeThread}
                    loading={Boolean(
                      selected && !activeThread && threadQuery.value?.id !== selectedId,
                    )}
                    unavailable={Boolean(
                      selected &&
                        (threadQuery.failed ||
                          (threadQuery.value?.id === selectedId && !activeThread)),
                    )}
                    onRetry={threadQuery.refresh}
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
        {handoffThread && (
          <HandoffDialog
            threadId={handoffThread}
            onClose={() => setHandoffThread(null)}
            onDraft={(next) => {
              setHandoffThread(null)
              setMinimised(null)
              setDraft(next)
            }}
          />
        )}
        {draft && (
          <Composer
            key={draft.id}
            draft={draft}
            accounts={accounts}
            onQueued={queued}
            onDiscarded={() => setDraft(null)}
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
      <ShortcutsDialog
        open={shortcutsOpen}
        onOpenChange={setShortcutsOpen}
        onCloseAutoFocus={restoreDialogFocus}
        snoozeEnabled={snoozeEnabled}
      />
      <AgentActivity
        open={agentOpen}
        onOpenChange={setAgentOpen}
        onCloseAutoFocus={restoreDialogFocus}
      />
      {sendSettings !== null && (
        <SendSettings
          initial={sendSettings}
          onClose={() => setSendSettings(null)}
          onCloseAutoFocus={restoreDialogFocus}
        />
      )}
      <CommandPalette
        open={paletteOpen}
        onOpenChange={setPaletteOpen}
        accounts={accounts}
        labels={labels}
        onView={goTo}
        onAccount={selectAccount}
        onSearch={(text) => void runSearch(text)}
        onToggleTheme={onToggleTheme}
        onCloseAutoFocus={restoreDialogFocus}
        actions={commandActions}
        appActions={appActions}
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
