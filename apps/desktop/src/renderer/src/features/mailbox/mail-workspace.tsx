import type { AccountSummary, Label } from '@amc/protocol'
import { useEffect, useMemo, useRef, useState } from 'react'
import { AgentActivity } from '@/components/agent-activity'
import { AppSidebar, systemViews } from '@/components/app-sidebar'
import { CommandPalette } from '@/components/command-palette'
import { DraftsView, OutboxView } from '@/components/compose-views'
import { MailSettings } from '@/components/mail-settings'
import { OrganisePicker } from '@/components/organise'
import { ShortcutsDialog } from '@/components/shortcuts-dialog'
import { SidebarInset, SidebarProvider } from '@/components/ui/sidebar'
import { getAmc } from '@/lib/amc'
import type { Counts, SyncStatus, View } from '../../../../shared/api'
import { useMailSearch } from '../search/use-mail-search'
import { ComposeOverlays } from './compose-overlays'
import { MailPanes, MailReader } from './mail-panes'
import { ReaderToolbar } from './reader-toolbar'
import { useMailCommands } from './use-mail-commands'
import { useMailCompose } from './use-mail-compose'
import { useMailDialogs } from './use-mail-dialogs'
import {
  INBOX,
  mailboxKey,
  useMailboxNavigation,
  useThreadSelection,
} from './use-mailbox-navigation'
import { useMailboxQuery } from './use-mailbox-query'
import { useMailboxRows } from './use-mailbox-rows'
import { useThreadActions } from './use-thread-actions'

const NO_ACCOUNTS: AccountSummary[] = []
const NO_LABELS: Label[] = []
const NO_COUNTS: Counts = { inbox: 0, inboxUnread: 0, starred: 0, drafts: 0, buckets: {} }

export function MailWorkspace({
  status,
  dark,
  onToggleTheme,
}: {
  status: SyncStatus
  dark: boolean
  onToggleTheme: () => void
}) {
  const [sidebarOpen, setSidebarOpen] = useState(true)
  const readerScroll = useRef<HTMLDivElement>(null)
  const snoozeEnabled = status.snoozeEnabled === true
  // Main retains progress on an interrupted bootstrap until the snapshot completes.
  const snapshotPending = status.phase === 'bootstrapping' || status.progress != null
  const { accountId, setAccountId, view, setView, notification, setNotification } =
    useMailboxNavigation(snoozeEnabled)
  const accountQuery = useMailboxQuery('accounts', () => getAmc().accounts(), !snapshotPending)
  const accounts = accountQuery.data ?? NO_ACCOUNTS
  const accountMissing =
    accountId !== null &&
    accountQuery.data !== undefined &&
    !accountQuery.data.some(({ id }) => id === accountId)
  if (accountMissing) setAccountId(null)
  const accountKey = JSON.stringify(accountId)
  const { data: labels = NO_LABELS } = useMailboxQuery(
    accountKey,
    () => getAmc().labels(accountId),
    !snapshotPending,
  )
  const { data: counts = NO_COUNTS } = useMailboxQuery(
    accountKey,
    () => getAmc().counts(accountId),
    !snapshotPending,
  )
  const self = useMemo(() => new Set(accounts.map((a) => a.address.toLowerCase())), [accounts])
  const labelNames = useMemo(() => new Map(labels.map((l) => [l.id, l.name])), [labels])

  const mailSearch = useMailSearch(accountId)
  const { search, input: searchInput, resetSearch, clearSearch, runSearch } = mailSearch
  const filter = mailSearch.filterText.trim()
  const key = mailboxKey(accountId, view, filter, search?.text)
  const mailbox = useMailboxRows({
    view,
    accountId,
    key,
    filter,
    hits: search?.hits ?? null,
    searching: search !== null,
    snapshotPending,
  })
  const selection = useThreadSelection(key, mailbox.rows, !search && !filter ? notification : null)
  const { selected, select, move, setSelection } = selection
  const details = useMailboxQuery(
    JSON.stringify([key, selected?.accountId, selected?.id]),
    async () => {
      if (!selected) return null
      const data = await getAmc().thread(selected.id)
      if (
        data &&
        (data.thread.id !== selected.id || data.thread.accountId !== selected.accountId)
      ) {
        throw new Error('Thread reply does not match the selected thread')
      }
      return data
    },
    !!selected && !snapshotPending,
  )
  const activeThread = details.data ?? null
  const actions = useThreadActions({
    selected,
    activeThread,
    accountId,
    accounts,
    labels,
    snoozeEnabled,
    syncPhase: status.phase,
  })
  const { organise, organisePicker, canUndoOrganise, setBucketPickerId } = actions
  const compose = useMailCompose(activeThread, accountId ?? accounts[0]?.id)
  const { openingComposer, openDraft, startCompose, setMinimised } = compose
  const dialogs = useMailDialogs()
  const { rememberFocus, restoreDialogFocus, openSendSettings } = dialogs

  const goTo = (next: View, target?: string) => {
    resetSearch(true)
    setBucketPickerId(null)
    setView(next)
    setNotification(null)
    select(target ?? null, mailboxKey(accountId, next, ''))
  }

  // Notification targets can be opened before they have arrived in the list query.
  useEffect(
    () =>
      getAmc().onOpenThread((target) => {
        const next = target.inInbox ? INBOX : { kind: 'all' as const }
        resetSearch(true)
        setBucketPickerId(null)
        setAccountId(null)
        setView(next)
        setNotification(target)
        setSelection({ key: mailboxKey(null, next, ''), id: target.id })
      }),
    [resetSearch, setAccountId, setView, setNotification, setBucketPickerId, setSelection],
  )

  const selectAccount = (id: string | null) => {
    resetSearch(false)
    setNotification(null)
    setBucketPickerId(null)
    setAccountId(id)
    select(null, mailboxKey(id, view, filter))
  }
  const ownView = !search && (view.kind === 'drafts' || view.kind === 'outbox')
  const { commandActions, appActions } = useMailCommands({
    accounts,
    selected,
    hasThread: !!activeThread,
    ownView,
    snoozeEnabled,
    actions,
    compose,
    dialogs,
    goTo,
    selectAccount,
    move,
    searchInput,
    readerScroll,
    clearSearch,
  })
  const title = search
    ? `Search: ${search.text}`
    : view.kind === 'label'
      ? (labelNames.get(view.labelId) ?? 'Label')
      : view.kind === 'bucket'
        ? view.bucket
        : (systemViews(snoozeEnabled).find((v) => v.view.kind === view.kind)?.title ?? 'Mail')

  return (
    <SidebarProvider
      open={sidebarOpen}
      onOpenChange={setSidebarOpen}
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
        onPalette={dialogs.openPalette}
        onAgent={() => {
          rememberFocus()
          dialogs.setAgentOpen(true)
        }}
        onShortcuts={() => {
          rememberFocus()
          dialogs.setShortcutsOpen(true)
        }}
        composing={openingComposer}
        counts={counts}
        labels={labels}
        status={status}
      />
      <SidebarInset className="min-w-0 overflow-hidden">
        {!sidebarOpen && <div className="app-drag h-11 shrink-0" />}
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
              goTo({ kind: 'sent' }, id)
              void getAmc().syncNow()
            }}
          />
        ) : (
          <MailPanes
            view={view}
            title={title}
            inboxCount={counts.inbox}
            mailSearch={mailSearch}
            mailbox={mailbox}
            selection={selection}
            self={self}
            readerToolbar={
              <ReaderToolbar
                selected={selected}
                activeThread={activeThread}
                actions={actions}
                compose={compose}
              />
            }
            reader={
              <MailReader
                data={activeThread}
                loading={!!selected && details.data === undefined && !details.failed}
                unavailable={!!selected && (details.failed || details.data === null)}
                failed={details.failed}
                onRetry={details.refresh}
                snoozeEnabled={snoozeEnabled}
                labelNames={labelNames}
                scrollRef={readerScroll}
              />
            }
          />
        )}
        <ComposeOverlays accounts={accounts} compose={compose} />
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
        open={dialogs.shortcutsOpen}
        onOpenChange={dialogs.setShortcutsOpen}
        onCloseAutoFocus={restoreDialogFocus}
        snoozeEnabled={snoozeEnabled}
      />
      <AgentActivity
        open={dialogs.agentOpen}
        onOpenChange={dialogs.setAgentOpen}
        onCloseAutoFocus={restoreDialogFocus}
      />
      {dialogs.sendSettings !== null && (
        <MailSettings
          initial={dialogs.sendSettings}
          onClose={() => dialogs.setSendSettings(null)}
          onCloseAutoFocus={restoreDialogFocus}
        />
      )}
      <CommandPalette
        open={dialogs.paletteOpen}
        onOpenChange={dialogs.setPaletteOpen}
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
          run: () => control.run(dialogs.paletteInvoker.current ?? undefined),
        }))}
        undo={canUndoOrganise ? organise.undo : undefined}
      />
    </SidebarProvider>
  )
}
