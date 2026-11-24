import type { Label } from '@amc/protocol'
import { useCallback, useEffect, useEffectEvent, useRef, useState } from 'react'
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
import type { MailLinkSearch, View } from '../../../../shared/api'
import { useMailSearch } from '../search/use-mail-search'
import { TriageReview } from '../triage-review/triage-review'
import { useTriageReview } from '../triage-review/use-triage-review'
import { ComposeOverlays } from './compose-overlays'
import { InboxArchiveLookahead } from './inbox-archive-lookahead'
import { MailPanes, MailReader } from './mail-panes'
import {
  accountsQuery,
  labelsQuery,
  type MailboxAccount,
  selectedThreadQuery,
} from './mailbox-queries'
import { ReaderToolbar } from './reader-toolbar'
import { useCompactMailbox } from './use-compact-mailbox'
import { useFilterActions } from './use-filter-actions'
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
import { useReaderFocus } from './use-reader-focus'
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
  const [readerSwitching, setReaderSwitching] = useState(false)
  const [sentTarget, setSentTarget] = useState<{
    scope: string
    id: string
    accountId: string
  } | null>(null)
  const snoozeEnabled = useSyncField((status) => status?.snoozeEnabled === true)
  const { accountId, setAccountId, view, setView, notification, setNotification } =
    useMailboxNavigation(snoozeEnabled)
  const accountData = useReplicaSelector(
    accountsQuery(),
    ({ data }) => data?.map(({ id, kind, imapMoves }) => ({ id, kind, imapMoves })),
    (left, right) => shareReply(left, right) === left,
  )
  const accounts = accountData ?? NO_ACCOUNTS
  const labels = useReplicaSelector(labelsQuery(accountId), ({ data }) => data ?? NO_LABELS)

  const mailSearch = useMailSearch(accountId)
  const { filter, search, input: searchInput, resetSearch, clearSearch, runSearch } = mailSearch
  // A link may resolve against fresher replica data than the renderer's account list.
  if (
    !search?.engineOrigin &&
    accountId !== null &&
    accountData &&
    !accountData.some(({ id }) => id === accountId)
  ) {
    setAccountId(null)
  }
  const key = mailboxKey(accountId, view, filter, search?.text)
  const mailbox = useMailboxRows({
    engineUrl,
    view,
    accountId,
    filter,
    hits: search?.hits ?? null,
    searching: search !== null,
  })
  const notificationRow = !search && !filter ? (notification?.thread ?? null) : null
  // A sent delivery can appear in Outbox before the Sent list has caught up.
  const pendingSent =
    sentTarget?.scope === key && !mailbox.ids?.includes(sentTarget.id) ? sentTarget : null
  if (sentTarget !== pendingSent) setSentTarget(null)
  const sectioned = view.kind === 'inbox' && !search && !filter
  const inbox = useInboxSections({
    scope: key,
    storageKey: JSON.stringify(['amc-inbox-collapse-v1', engineUrl, accountId]),
  })
  const { focus: inboxFocus, openSender } = inbox
  const notificationPresence = useReplicaSelector(
    notificationRow ? mailbox.query : null,
    ({ data }) => {
      if (!notificationRow || !data) return 'unknown'
      if (!data.summaries.has(notificationRow.id)) return 'missing'
      return sectioned && !inbox.readIds(data)?.includes(notificationRow.id) ? 'hidden' : 'visible'
    },
  )
  if (notification) {
    // Keep explicitly opened rows accessible while their Inbox section is collapsed.
    if (
      notificationPresence === 'visible' ||
      (notification.confirmed && notificationPresence === 'missing')
    ) {
      setNotification(null)
    } else if (notificationPresence === 'hidden' && !notification.confirmed) {
      setNotification({ ...notification, confirmed: true })
    }
  }
  const {
    selectedId,
    ids,
    select,
    move: moveSelection,
    setSelection,
  } = useThreadSelection(
    key,
    mailbox.ids,
    notificationRow?.id ?? pendingSent?.id,
    sectioned ? mailbox.query : null,
    inbox,
  )
  const move = (delta: number) => {
    if (!sectioned || !inboxFocus.current?.move(delta)) moveSelection(delta)
  }
  const listed = useReplicaSelector(mailbox.query, ({ data }) =>
    selectedId === null
      ? undefined
      : (data?.summaries.get(selectedId) ??
        mailbox.searchRows?.summaries.get(selectedId) ??
        (notificationRow?.id === selectedId ? notificationRow : undefined)),
  )
  const selectedTarget = selectedId === pendingSent?.id ? pendingSent : null
  const readerTarget = listed ?? selectedTarget ?? undefined
  const readerQuery = selectedThreadQuery(engineUrl, readerTarget)
  const selectedDetail = useReplicaSelector(
    readerQuery,
    ({ data }) =>
      data
        ? { thread: data.thread, complete: data.messages.length === data.thread.messageCount }
        : null,
    (left, right) => left?.thread === right?.thread && left?.complete === right?.complete,
  )
  const activeThread = selectedDetail?.thread ?? null
  const selected = listed ?? (selectedTarget && activeThread ? activeThread : undefined)
  const actionableThread = readerSwitching ? null : activeThread
  const actionableSelection = readerSwitching ? undefined : selected
  const actions = useThreadActions({
    selected: actionableSelection,
    activeThread: actionableThread,
    complete: selectedDetail?.complete === true,
    accountId,
    accounts,
    labels,
    snoozeEnabled,
  })
  const { organise, organisePicker, canUndoOrganise, setBucketPickerId } = actions
  const getFilterActions = useFilterActions(accounts, labels)
  const filterActions = actionableSelection ? getFilterActions(actionableSelection) : []
  const review = useTriageReview(accountId)
  const { close: closeReview } = review
  const compose = useMailCompose(actionableThread, accountId ?? accounts[0]?.id, review.onQueued)
  const { openingComposer, openDraft, startCompose, setMinimised } = compose
  const dialogs = useMailDialogs()
  const { rememberFocus, restoreDialogFocus, openSendSettings } = dialogs
  const ownView = !search && (view.kind === 'drafts' || view.kind === 'outbox')
  const compact = useCompactMailbox()
  const readerScope = inbox.senderId === null ? key : JSON.stringify([key, inbox.senderId])
  const readerFocus = useReaderFocus(
    readerScope,
    selectedId,
    !!(compact ? selected : activeThread) && !ownView && !openingComposer,
    compact,
  )
  const { expanded, collapse, open } = readerFocus
  const openSelectedThread = useCallback(() => open(readerScope), [readerScope, open])
  if (!readerFocus.visible) {
    if (actions.bucketPickerOpen) setBucketPickerId(null)
    if (pendingSent) setSentTarget(null)
  }
  const paletteReaderThread = useRef<string | null>(null)

  const focusSearch = () => {
    if (expanded) readerFocus.exit(searchInput.current)
    else searchInput.current?.focus()
  }

  const goTo = (next: View) => {
    collapse()
    resetSearch(true)
    openSender(null)
    setBucketPickerId(null)
    setView(next)
    setNotification(null)
    setSentTarget(null)
    select(null, mailboxKey(accountId, next, ''))
  }

  const openSentThread = (id: string, deliveryAccount: string) => {
    const next = { kind: 'sent' } as const
    const destination = mailboxKey(accountId, next, '')
    goTo(next)
    setSentTarget({ scope: destination, id, accountId: deliveryAccount })
    select(id, destination)
    open(destination)
    void getAmc().syncNow()
  }

  const openMailSearch = useEffectEvent(
    ({ query, accountId: target, engineOrigin }: MailLinkSearch) => {
      collapse()
      closeReview(false)
      resetSearch(true)
      openSender(null)
      setBucketPickerId(null)
      setNotification(null)
      setAccountId(target)
      const next = { kind: 'all' } as const
      setView(next)
      setSelection({ key: mailboxKey(target, next, '', query.trim()), id: null })
      void runSearch(query, target, 0, engineOrigin)
    },
  )

  // Install the search listener before onOpenThread announces navigation readiness.
  // Notification targets can be opened before they have arrived in the list query.
  // biome-ignore lint/correctness/useExhaustiveDependencies: React Effect Events are intentionally excluded from effect dependencies.
  useEffect(() => {
    const removeSearch = getAmc().onOpenMailSearch((target) => openMailSearch(target))
    const removeThread = getAmc().onOpenThread((target) => {
      collapse()
      closeReview(false)
      const next = target.inInbox ? INBOX : { kind: 'all' as const }
      resetSearch(true)
      openSender(null)
      setBucketPickerId(null)
      setAccountId(null)
      setView(next)
      setNotification({ thread: target, confirmed: false })
      const destination = mailboxKey(null, next, '')
      setSelection({ key: destination, id: target.id })
      open(destination)
    })
    return () => {
      removeSearch()
      removeThread()
    }
  }, [
    resetSearch,
    setAccountId,
    setView,
    setNotification,
    setBucketPickerId,
    setSelection,
    openSender,
    closeReview,
    collapse,
    open,
  ])

  const selectAccount = (id: string | null) => {
    collapse()
    resetSearch(false)
    setNotification(null)
    setBucketPickerId(null)
    setAccountId(id)
    select(null, mailboxKey(id, view, filter))
  }
  const { commandActions, appActions, copyReference } = useMailCommands({
    accounts,
    selected: actionableSelection,
    activeThreadId: actionableThread?.id,
    filterActions,
    ownView,
    snoozeEnabled,
    actions,
    compose,
    dialogs,
    goTo,
    selectAccount,
    move,
    jumpSection: sectioned && inbox.senderId === null && !expanded ? inboxFocus : undefined,
    focusSearch,
    readerFocus,
    queueReaderToggle: () => {
      paletteReaderThread.current = selectedId
    },
    clearSearch,
    reviewOpen: review.open,
    openReview:
      sectioned &&
      !expanded &&
      getAmc().smartInbox?.review &&
      !compose.draft &&
      !compose.handoffThread &&
      !openingComposer &&
      !organisePicker &&
      !actions.bucketPickerOpen &&
      !dialogs.shortcutsOpen &&
      !dialogs.agentOpen &&
      dialogs.sendSettings === null
        ? () =>
            review.enter(
              dialogs.paletteOpen ? dialogs.paletteInvoker.current : document.activeElement,
            )
        : undefined,
  })
  const title = search
    ? 'Search results'
    : view.kind === 'label'
      ? (labels.find((label) => label.id === view.labelId)?.name ?? 'Label')
      : view.kind === 'bucket'
        ? view.bucket
        : (systemViews(snoozeEnabled).find((v) => v.view.kind === view.kind)?.title ?? 'Mail')

  const feedbackView =
    dialogs.sendSettings !== null
      ? 'settings'
      : compose.draft
        ? 'composer'
        : review.open
          ? 'triage'
          : search
            ? 'search'
            : filter
              ? 'filter'
              : view.kind

  return (
    <SidebarProvider
      data-feedback-view={feedbackView}
      open={sidebarOpen}
      onOpenChange={(open) => {
        if (!expanded) setSidebarOpen(open)
      }}
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
        obscured={expanded}
      />
      <SidebarInset className="min-w-0 overflow-hidden">
        {!sidebarOpen && <div className={expanded ? 'h-11 shrink-0' : 'app-drag h-11 shrink-0'} />}
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
            onSettings={openSendSettings}
            onThread={openSentThread}
          />
        ) : (
          <MailPanes
            view={view}
            title={title}
            accountId={accountId}
            mailSearch={mailSearch}
            mailbox={mailbox}
            inbox={sectioned ? inbox : undefined}
            ids={selectedTarget && !activeThread ? mailbox.ids : ids}
            selectedId={selectedId}
            notification={notificationRow ?? (selectedTarget ? activeThread : null)}
            onSelect={select}
            onOpenThread={openSelectedThread}
            move={move}
            getFilterActions={getFilterActions}
            expanded={expanded}
            compact={compact}
            listRef={readerFocus.list}
            readerRef={readerFocus.reader}
            readerToolbar={
              <ReaderToolbar
                selected={actionableSelection}
                activeThread={actionableThread}
                actions={actions}
                filterActions={filterActions}
                compose={compose}
                expanded={expanded}
                canExpand={readerFocus.canExpand}
                onToggleFocus={readerFocus.toggle}
                onCopyThreadReference={copyReference}
              />
            }
            reader={
              <MailReader
                engineUrl={engineUrl}
                scope={readerScope}
                onSwitching={setReaderSwitching}
                selectedId={readerTarget?.id}
                selectedAccountId={readerTarget?.accountId}
                accountId={accountId}
                snoozeEnabled={snoozeEnabled}
                readerRef={readerFocus.reader}
                scrollRef={readerFocus.scroll}
                expanded={expanded}
                onEditDraft={compose.openDraftByMessage}
                draftEditingDisabled={Boolean(compose.draft || openingComposer)}
              />
            }
          />
        )}
        {sectioned && organise.controls.some(({ id }) => id === 'archive') && (
          <InboxArchiveLookahead
            engineUrl={engineUrl}
            mailbox={mailbox.query}
            selectedId={selectedId}
            readIds={inbox.readIds}
          />
        )}
        <ComposeOverlays compose={compose} />
      </SidebarInset>
      {organisePicker && (
        <OrganisePicker
          picker={organisePicker}
          labels={labels}
          onClose={() => organise.setPicker(null)}
          focusFallback={() => {
            if (expanded) (readerFocus.scroll.current ?? readerFocus.reader.current)?.focus()
            else searchInput.current?.focus()
          }}
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
      <MailboxCommandPalette
        open={dialogs.paletteOpen}
        onOpenChange={dialogs.setPaletteOpen}
        labels={labels}
        onView={goTo}
        onAccount={selectAccount}
        accountId={accountId}
        onSearch={(text) => {
          collapse()
          void runSearch(text)
        }}
        onToggleTheme={onToggleTheme}
        onCloseAutoFocus={(event) => {
          const threadId = paletteReaderThread.current
          paletteReaderThread.current = null
          if (threadId !== null && threadId === selectedId && (expanded || readerFocus.canExpand)) {
            // Capture the reading position after the palette releases pointer and focus handling.
            event.preventDefault()
            readerFocus.toggle(dialogs.paletteInvoker.current)
          } else {
            restoreDialogFocus(event)
          }
        }}
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
      {review.open && (
        <TriageReview
          store={review.store}
          accountId={accountId}
          labels={labels}
          suspended={!!compose.draft || openingComposer}
          snoozeEnabled={snoozeEnabled}
          onClose={() => closeReview()}
          onOutbox={() => {
            closeReview(false)
            goTo({ kind: 'outbox' })
          }}
          onReply={async (card) => {
            await review.store.validate(card)
            const record = review.store.prepareReply(card)
            const draft = await compose.startCompose('reply', card.detail.thread)
            if (draft) review.rememberReply(record, draft.id)
          }}
        />
      )}
      {dialogs.sendSettings !== null && (
        <MailSettings
          initial={dialogs.sendSettings}
          onClose={() => dialogs.setSendSettings(null)}
          onCloseAutoFocus={dialogs.restoreSettingsFocus}
        />
      )}
    </SidebarProvider>
  )
}

function MailboxCommandPalette(
  props: Omit<React.ComponentProps<typeof CommandPalette>, 'accounts'>,
) {
  const accounts = useReplicaSelector(props.open ? accountsQuery() : null, ({ data }) => data)
  return <CommandPalette {...props} accounts={accounts ?? []} />
}
