import type { ThreadSummary } from '@amc/protocol'
import { useCallback, useMemo, useState } from 'react'
import type { View } from '../../../../shared/api'

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
  notificationId: string | undefined,
) {
  const [selection, setSelection] = useState<{ key: string; id: string | null }>({ key, id: null })
  const requestedId = selection.key === key ? selection.id : null
  const includeNotification =
    notificationId !== undefined && notificationId === requestedId && !ids?.includes(notificationId)
  const orderedIds = useMemo(
    () => (includeNotification ? [notificationId, ...(ids ?? [])] : ids),
    [includeNotification, notificationId, ids],
  )
  const selectedId =
    orderedIds === undefined || (requestedId !== null && orderedIds.includes(requestedId))
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
