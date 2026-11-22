import type { ThreadSummary } from '@amc/protocol'
import { useState } from 'react'
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
  rows: ThreadSummary[] | undefined,
  notification: ThreadSummary | null,
) {
  const [selection, setSelection] = useState<{ key: string; id: string | null }>({ key, id: null })
  const requestedId = selection.key === key ? selection.id : null
  const threads =
    notification &&
    notification.id === requestedId &&
    !rows?.some((row) => row.id === notification.id)
      ? [notification, ...(rows ?? [])]
      : rows
  const selected = threads?.find((row) => row.id === requestedId) ?? threads?.[0]
  const id = threads === undefined ? requestedId : (selected?.id ?? null)
  if (selection.key !== key || selection.id !== id) setSelection({ key, id })

  return {
    selected,
    threads,
    setSelection,
    select: (id: string | null, destination = key) => setSelection({ key: destination, id }),
    move: (delta: number) => {
      if (!threads?.length) return
      const index = Math.max(
        0,
        threads.findIndex((row) => row.id === id),
      )
      const next = threads[Math.min(threads.length - 1, Math.max(0, index + delta))]
      if (next) setSelection({ key, id: next.id })
    },
  }
}
