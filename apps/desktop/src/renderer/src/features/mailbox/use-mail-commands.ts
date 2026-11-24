import { BUCKETS, type ThreadSummary } from '@amc/protocol'
import {
  Activity,
  CircleHelp,
  Copy,
  Forward,
  Layers,
  ListChecks,
  Maximize2,
  Minimize2,
  Reply,
  ReplyAll,
  SendToBack,
  Settings2,
  SquarePen,
  X,
} from 'lucide-react'
import { activeBuckets, bucketKey, useBucketCatalog } from '@/data/buckets'
import { useHotkeys } from '@/hooks/use-hotkeys'
import { copyDiagnostics } from '@/lib/diagnostics'
import { mailShortcuts, shortcutLabel } from '@/lib/mail-shortcuts'
import type { View } from '../../../../shared/api'
import {
  copyThreadReference,
  copyThreadReferenceLabel,
  copyThreadReferenceShortcut,
} from './thread-reference'
import type { FilterAction } from './use-filter-actions'
import type { InboxNavigation } from './use-inbox-sections'
import type { useMailCompose } from './use-mail-compose'
import type { useMailDialogs } from './use-mail-dialogs'
import type { useReaderFocus } from './use-reader-focus'
import type { useThreadActions } from './use-thread-actions'

export function useMailCommands({
  accounts,
  selected,
  activeThreadId,
  filterActions,
  ownView,
  snoozeEnabled,
  actions,
  compose,
  dialogs,
  goTo,
  selectAccount,
  move,
  jumpSection,
  focusSearch,
  readerFocus,
  queueReaderToggle,
  clearSearch,
  reviewOpen,
  openReview,
}: {
  accounts: { id: string }[]
  selected: ThreadSummary | undefined
  activeThreadId: string | undefined
  filterActions: FilterAction[]
  ownView: boolean
  snoozeEnabled: boolean
  actions: ReturnType<typeof useThreadActions>
  compose: ReturnType<typeof useMailCompose>
  dialogs: ReturnType<typeof useMailDialogs>
  goTo: (view: View) => void
  selectAccount: (id: string | null) => void
  move: (delta: number) => void
  jumpSection?: InboxNavigation['focus']
  focusSearch: () => void
  readerFocus: ReturnType<typeof useReaderFocus>
  queueReaderToggle: () => void
  clearSearch: () => void
  reviewOpen: boolean
  openReview?: () => void
}) {
  const catalog = useBucketCatalog()
  const {
    bucketPickerOpen,
    setBucketPickerId,
    setBucket,
    activeHandoff,
    endingHandoff,
    endHandoff,
    organise,
    canUndoOrganise,
    organisePicker,
  } = actions
  const { draft, handoffThread, setHandoffThread, openingComposer, minimised, startCompose } =
    compose
  const {
    paletteOpen,
    shortcutsOpen,
    agentOpen,
    sendSettings,
    rememberFocus,
    openPalette,
    setAgentOpen,
    setShortcutsOpen,
    openSendSettings,
  } = dialogs
  const {
    expanded,
    compact,
    visible,
    canExpand,
    reader,
    scroll: readerScroll,
    toggle,
    exit,
  } = readerFocus
  const canHandOff = !ownView && !draft && !openingComposer && !!selected && !!activeThreadId
  const handOff = () => {
    if (canHandOff && selected) setHandoffThread(selected.id)
  }
  const copyReference =
    !ownView && !reviewOpen && !draft && !openingComposer && activeThreadId !== undefined
      ? () => void copyThreadReference(activeThreadId)
      : undefined
  const commandActions = [
    ...(expanded || canExpand
      ? [
          {
            name: expanded ? 'Back to mailbox' : compact ? 'Open selected thread' : 'Focus reader',
            icon: expanded ? Minimize2 : Maximize2,
            shortcut: shortcutLabel(mailShortcuts.focusReader),
            run: queueReaderToggle,
          },
        ]
      : []),
    {
      name: minimised ? 'Resume draft' : 'Compose message',
      icon: SquarePen,
      shortcut: shortcutLabel(mailShortcuts.compose),
      run: () => void startCompose('new'),
    },
    ...(activeThreadId && !ownView && !openingComposer
      ? [
          {
            name: 'Reply',
            icon: Reply,
            shortcut: shortcutLabel(mailShortcuts.reply),
            run: () => void startCompose('reply'),
          },
          {
            name: 'Reply all',
            icon: ReplyAll,
            shortcut: shortcutLabel(mailShortcuts.replyAll),
            run: () => void startCompose('reply-all'),
          },
          {
            name: 'Forward',
            icon: Forward,
            shortcut: shortcutLabel(mailShortcuts.forward),
            run: () => void startCompose('forward'),
          },
        ]
      : []),
    ...(selected && !ownView
      ? [
          ...(visible
            ? [
                {
                  name: 'Choose a Bucket',
                  icon: Layers,
                  shortcut: shortcutLabel(mailShortcuts.bucket),
                  run: () => setBucketPickerId(selected.id),
                },
              ]
            : []),
          ...activeBuckets(catalog).map((item, index) => ({
            name: `Move to Bucket: ${item.name}`,
            icon: Layers,
            ...(item.builtIn ? { shortcut: String(index + 1) } : {}),
            run: () => void setBucket(bucketKey(item)),
          })),
          ...(selected.bucket || selected.bucketAssignment
            ? [{ name: 'Clear Bucket', icon: X, run: () => void setBucket(null) }]
            : []),
        ]
      : []),
    ...(canHandOff
      ? [
          {
            name: 'Hand off',
            icon: SendToBack,
            shortcut: shortcutLabel(mailShortcuts.handOff),
            run: handOff,
          },
        ]
      : []),
    ...(copyReference
      ? [
          {
            name: copyThreadReferenceLabel,
            icon: Copy,
            shortcut: copyThreadReferenceShortcut,
            run: copyReference,
          },
        ]
      : []),
    ...(activeHandoff && endingHandoff !== activeHandoff.id
      ? [{ name: 'End hand-off', icon: X, run: () => void endHandoff(activeHandoff.id) }]
      : []),
  ]
  const appActions = [
    ...(openReview
      ? [{ name: 'Triage Inbox', icon: ListChecks, shortcut: 'T', run: openReview }]
      : []),
    { name: 'Agent activity', icon: Activity, run: () => setAgentOpen(true) },
    { name: 'Settings', icon: Settings2, run: openSendSettings },
    { name: 'Copy Diagnostics', icon: Copy, run: copyDiagnostics },
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
      [mailShortcuts.compose]: () => void startCompose('new'),
      [mailShortcuts.reply]: () => {
        if (!ownView) void startCompose('reply')
      },
      [mailShortcuts.replyAll]: () => {
        if (!ownView) void startCompose('reply-all')
      },
      [mailShortcuts.forward]: () => {
        if (!ownView) void startCompose('forward')
      },
      ...Object.fromEntries(
        filterActions.flatMap(({ shortcut, disabled, run }) =>
          shortcut && !disabled && !ownView
            ? [
                [
                  shortcut,
                  (event: KeyboardEvent) => {
                    if (!event.repeat) run()
                  },
                ],
              ]
            : [],
        ),
      ),
      [mailShortcuts.handOff]: (event) => {
        if (!event.repeat) handOff()
      },
      ...(copyReference
        ? {
            [mailShortcuts.copyThreadReference]: {
              run: copyReference,
              when: canCopyReferenceWithHotkey,
            },
          }
        : {}),
      ...(openReview
        ? {
            t: (event: KeyboardEvent) => {
              if (!event.repeat) openReview()
            },
          }
        : {}),
      '?': () => {
        rememberFocus()
        setShortcutsOpen(true)
      },
      'g o': () => goTo({ kind: 'outbox' }),
      ...(expanded || canExpand
        ? {
            [mailShortcuts.focusReader]: (event: KeyboardEvent) => {
              if (!event.repeat) {
                const trigger = document.activeElement
                toggle(trigger instanceof HTMLElement ? trigger : null)
              }
            },
          }
        : {}),
      [mailShortcuts.bucket]: (event) => {
        if (!event.repeat && selected && !ownView && visible) setBucketPickerId(selected.id)
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
      k: () => move(-1),
      ...(!expanded ? { arrowdown: () => move(1), arrowup: () => move(-1) } : {}),
      ...(jumpSection
        ? {
            'shift+j': () => jumpSection.current?.jump(1),
            'shift+k': () => jumpSection.current?.jump(-1),
          }
        : {}),
      space: () =>
        readerScroll.current?.scrollBy({
          top: readerScroll.current.clientHeight * 0.8,
          behavior: matchMedia('(prefers-reduced-motion: reduce)').matches ? 'instant' : 'smooth',
        }),
      [mailShortcuts.filterMail]: focusSearch,
      [mailShortcuts.searchMail]: focusSearch,
      'mod+k': openPalette,
      [mailShortcuts.escape]: (event) => {
        if (event.repeat) return
        if (expanded) exit()
        else clearSearch()
      },
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
    !reviewOpen &&
      !draft &&
      !paletteOpen &&
      !shortcutsOpen &&
      !agentOpen &&
      sendSettings === null &&
      !handoffThread &&
      !organisePicker &&
      !bucketPickerOpen,
    reader,
  )

  return { commandActions, appActions, copyReference }
}

function canCopyReferenceWithHotkey(event: KeyboardEvent): boolean {
  const target = event.target as HTMLElement | null
  return (
    !event.repeat &&
    !target?.isContentEditable &&
    !target?.closest?.('input, textarea, select, [role="textbox"]') &&
    (target?.ownerDocument ?? document).getSelection()?.isCollapsed !== false
  )
}
