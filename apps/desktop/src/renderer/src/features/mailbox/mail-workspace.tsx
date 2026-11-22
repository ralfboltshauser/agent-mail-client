import type { Label } from '@amc/protocol'
import { useEffect, useRef, useState } from 'react'
import { AgentActivity } from '@/components/agent-activity'
import { AppSidebar, systemViews } from '@/components/app-sidebar'
import { CommandPalette } from '@/components/command-palette'
import { DraftsView, OutboxView } from '@/components/compose-views'
import { MailSettings } from '@/components/mail-settings'
import { OrganiseNotices, OrganisePicker } from '@/components/organise'
import { ShortcutsDialog } from '@/components/shortcuts-dialog'
import { SidebarInset, SidebarProvider } from '@/components/ui/sidebar'
import { shareReply } from '@/data/share-reply'
import { useReplicaSelector, useSyncField } from '@/hooks/use-amc'
import { getAmc } from '@/lib/amc'
import type { View } from '../../../../shared/api'
import { useMailSearch } from '../search/use-mail-search'
import { ComposeOverlays } from './compose-overlays'
import { MailPanes, MailReader } from './mail-panes'
import {
  accountsQuery,
  labelsQuery,
  type MailboxAccount,
  selectedThreadQuery,
} from './mailbox-queries'
import { ReaderToolbar } from './reader-toolbar'
import { useInboxSections } from './use-inbox-sections'
import { useMailCommands } from './use-mail-commands'
import { useMailCompose } from './use-mail-compose'
import { useMailDialogs } from './use-mail-dialogs'
import {
  INBOX,
  mailboxKey,
  useMailboxNavigation,
  useThreadSelection,
} from './use-mailbox-navigation'
import { useMailboxRows } from './use-mailbox-rows'
import { useThreadActions } from './use-thread-actions'

const NO_ACCOUNTS: MailboxAccount[] = []
const NO_LABELS: Label[] = []

export function MailWorkspace({
  engineUrl,
  dark,
  onToggleTheme,
}: {
  engineUrl: string | null
  dark: boolean
  onToggleTheme: () => void
}) {
  const [sidebarOpen, setSidebarOpen] = useState(true)
  const readerScroll = useRef<HTMLDivElement>(null)
  const snoozeEnabled = useSyncField((status) => status?.snoozeEnabled === true)
  const { accountId, setAccountId, view, setView, notification, setNotification } =
    useMailboxNavigation(snoozeEnabled)
  const accountData = useReplicaSelector(
    accountsQuery(),
    ({ data }) => data?.map(({ id, kind, imapMoves }) => ({ id, kind, imapMoves })),
    (left, right) => shareReply(left, right) === left,
  )
  const accounts = accountData ?? NO_ACCOUNTS
  if (accountId !== null && accountData && !accountData.some(({ id }) => id === accountId)) {
    setAccountId(null)
  }
  const labels = useReplicaSelector(labelsQuery(accountId), ({ data }) => data ?? NO_LABELS)

  const mailSearch = useMailSearch(accountId)
  const { search, input: searchInput, resetSearch, clearSearch, runSearch } = mailSearch
  const filter = mailSearch.filterText.trim()
  const key = mailboxKey(accountId, view, filter, search?.text)
  const mailbox = useMailboxRows({
    engineUrl,
    view,
    accountId,
    filter,
    hits: search?.hits ?? null,
    searching: search !== null,
  })
  const notificationRow = !search && !filter ? notification : null
  const sectioned = view.kind === 'inbox' && !search && !filter
  const inbox = useInboxSections({
    scope: key,
    storageKey: JSON.stringify(['amc-inbox-collapse-v1', engineUrl, accountId]),
  })
  const { focus: inboxFocus, openSender } = inbox
  const {
    selectedId,
    ids,
    select,
    move: moveSelection,
    setSelection,
  } = useThreadSelection(
    key,
    mailbox.ids,
    notificationRow?.id,
    sectioned ? mailbox.query : null,
    inbox,
  )
  const move = (delta: number) => {
    if (!sectioned || !inboxFocus.current?.move(delta)) moveSelection(delta)
  }
  const selected = useReplicaSelector(mailbox.query, ({ data }) =>
    selectedId === null
      ? undefined
      : (data?.summaries.get(selectedId) ??
        mailbox.searchRows?.summaries.get(selectedId) ??
        (notificationRow?.id === selectedId ? notificationRow : undefined)),
  )
  const readerQuery = selectedThreadQuery(engineUrl, selected)
  const selectedDetail = useReplicaSelector(
    readerQuery,
    ({ data }) =>
      data
        ? { thread: data.thread, complete: data.messages.length === data.thread.messageCount }
        : null,
    (left, right) => left?.thread === right?.thread && left?.complete === right?.complete,
  )
  const activeThread = selectedDetail?.thread ?? null
  const actions = useThreadActions({
    selected,
    activeThread,
    complete: selectedDetail?.complete === true,
    accountId,
    accounts,
    labels,
    snoozeEnabled,
  })
  const { organise, organisePicker, canUndoOrganise, setBucketPickerId } = actions
  const compose = useMailCompose(activeThread, accountId ?? accounts[0]?.id)
  const { openingComposer, openDraft, startCompose, setMinimised } = compose
  const dialogs = useMailDialogs()
  const { rememberFocus, restoreDialogFocus, openSendSettings } = dialogs

  const goTo = (next: View, target?: string) => {
    resetSearch(true)
    openSender(null)
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
        openSender(null)
        setBucketPickerId(null)
        setAccountId(null)
        setView(next)
        setNotification(target)
        setSelection({ key: mailboxKey(null, next, ''), id: target.id })
      }),
    [
      resetSearch,
      setAccountId,
      setView,
      setNotification,
      setBucketPickerId,
      setSelection,
      openSender,
    ],
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
    jumpSection: sectioned && inbox.senderId === null ? inboxFocus : undefined,
    searchInput,
    readerScroll,
    clearSearch,
  })
  const title = search
    ? `Search: ${search.text}`
    : view.kind === 'label'
      ? (labels.find((label) => label.id === view.labelId)?.name ?? 'Label')
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
      <OrganiseNotices />
      <AppSidebar
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
        snoozeEnabled={snoozeEnabled}
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
            accountId={accountId}
            mailSearch={mailSearch}
            mailbox={mailbox}
            inbox={sectioned ? inbox : undefined}
            ids={ids}
            selectedId={selectedId}
            notification={notificationRow}
            onSelect={select}
            move={move}
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
                engineUrl={engineUrl}
                selectedId={selected?.id}
                selectedAccountId={selected?.accountId}
                accountId={accountId}
                snoozeEnabled={snoozeEnabled}
                scrollRef={readerScroll}
              />
            }
          />
        )}
        <ComposeOverlays compose={compose} />
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
      <MailboxCommandPalette
        open={dialogs.paletteOpen}
        onOpenChange={dialogs.setPaletteOpen}
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

function MailboxCommandPalette(
  props: Omit<React.ComponentProps<typeof CommandPalette>, 'accounts'>,
) {
  const accounts = useReplicaSelector(props.open ? accountsQuery() : null, ({ data }) => data)
  return <CommandPalette {...props} accounts={accounts ?? []} />
}
