import type { ThreadSummary } from '@amc/protocol'
import { useCallback, useMemo, useState } from 'react'
import { inboxSelectionFallback } from '@/data/selection'
import { useReplicaSelector } from '@/hooks/use-amc'
import type { View } from '../../../../shared/api'
import type { MailboxThreadQuery } from './mailbox-queries'
import type { InboxNavigation } from './use-inbox-sections'

export const INBOX: View = { kind: 'inbox' }

export function mailboxKey(accountId: string | null, view: View, filter: string, search?: string) {
  return JSON.stringify([
    accountId,
    view,
    search === undefined ? ['filter', filter] : ['search', search],
  ])
}

export function useMailboxNavigation(snoozeEnabled: boolean) {
  const [accountId, setAccountId] = useState<string | null>(null)
  const [selectedView, setView] = useState<View>(INBOX)
  const [notification, setNotification] = useState<ThreadSummary | null>(null)
  const view = !snoozeEnabled && selectedView.kind === 'snoozed' ? INBOX : selectedView
  if (view !== selectedView) setView(view)
  return { accountId, setAccountId, view, setView, notification, setNotification }
}

export function useThreadSelection(
  key: string,
  ids: readonly string[] | undefined,
  pendingTargetId: string | undefined,
  inboxQuery: MailboxThreadQuery | null,
  inbox: InboxNavigation,
) {
  const [selection, setSelection] = useState<{ key: string; id: string | null }>({ key, id: null })
  const requestedId = selection.key === key ? selection.id : null
  const includeTarget =
    pendingTargetId !== undefined &&
    pendingTargetId === requestedId &&
    !ids?.includes(pendingTargetId)
  const orderedIds = useMemo(
    () => (includeTarget ? [pendingTargetId, ...(ids ?? [])] : ids),
    [includeTarget, pendingTargetId, ids],
  )
  const inboxSelected = useReplicaSelector(inboxQuery, ({ data }) => {
    const visible = inbox.readIds(data)
    if (
      !visible ||
      (requestedId !== null && (requestedId === pendingTargetId || visible.includes(requestedId)))
    ) {
      return requestedId
    }
    return inboxSelectionFallback(inbox.getPreviousOrder(), visible, requestedId)
  })
  const selectedId = inboxQuery
    ? inboxSelected
    : orderedIds === undefined || (requestedId !== null && orderedIds.includes(requestedId))
      ? requestedId
      : (orderedIds[0] ?? null)
  if (selection.key !== key || selection.id !== selectedId) setSelection({ key, id: selectedId })

  const select = useCallback(
    (id: string | null, destination = key) => setSelection({ key: destination, id }),
    [key],
  )
  const move = useCallback(
    (delta: number) => {
      if (!orderedIds?.length) return
      const index = selectedId === null ? 0 : Math.max(0, orderedIds.indexOf(selectedId))
      const next = orderedIds[Math.min(orderedIds.length - 1, Math.max(0, index + delta))]
      if (next) setSelection({ key, id: next })
    },
    [key, orderedIds, selectedId],
  )

  return { selectedId, ids: orderedIds, setSelection, select, move }
}
