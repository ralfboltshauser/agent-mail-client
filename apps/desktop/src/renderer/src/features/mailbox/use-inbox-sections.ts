import { type BucketDefinition, BucketId } from '@amc/protocol'
import { useCallback, useEffect, useMemo, useRef, useState } from 'react'
import { useBucketOrder } from '@/data/buckets'
import { shareReply } from '@/data/share-reply'
import type { InboxSection, ThreadIndex } from '@/data/thread-queries'
import { recordCaughtFailure } from '@/lib/failure'

const NO_IDS: readonly string[] = []
type CollapsePreferences = Partial<Record<InboxSection, boolean>>

export type InboxItem =
  | { kind: 'header'; section: InboxSection; id: string }
  | { kind: 'sender' | 'thread'; section: InboxSection; id: string; threadId: string }

interface InboxFocus {
  jump: (delta: number) => void
  move: (delta: number) => boolean
}

export const inboxHeaderId = (section: InboxSection) => `header:${section}`

function readPreferences(key: string): CollapsePreferences {
  try {
    const stored = JSON.parse(localStorage.getItem(key) ?? '{}')
    return Object.fromEntries(
      Object.entries(stored ?? {}).flatMap(([key, value]) =>
        value === true &&
        (key === 'New senders' || key === 'Unassigned' || BucketId.safeParse(key).success)
          ? [[key, true]]
          : [],
      ),
    )
  } catch (error) {
    recordCaughtFailure(error)

    return {}
  }
}

// Cache only derived topology, so snapshot reads can share a value across subscribers.
function inboxLayoutSelector(
  collapsed: CollapsePreferences,
  bucketOrder: readonly BucketDefinition['id'][],
) {
  const sectionOrder: readonly InboxSection[] = ['New senders', ...bucketOrder]
  const ordered = new Set<InboxSection>([...sectionOrder, 'Unassigned'])
  let previousOrder: NonNullable<ThreadIndex['inbox']>['sections'] | undefined
  let previousLayout: { items: readonly InboxItem[]; ids: readonly string[] } | undefined
  return (data: ThreadIndex | undefined) => {
    const order = data?.inbox?.sections
    if (!order) return undefined
    if (
      previousOrder &&
      previousOrder.size === order.size &&
      [...order].every(
        ([section, entry]) =>
          previousOrder?.get(section)?.ids === entry.ids &&
          previousOrder.get(section)?.rowIds === entry.rowIds,
      )
    )
      return previousLayout
    previousOrder = order
    const items: InboxItem[] = []
    const ids: string[] = []
    // A thread may arrive before its custom Bucket definition.
    const unknown = [...order.keys()].filter((section) => !ordered.has(section)).sort()
    for (const section of [...sectionOrder, ...unknown, 'Unassigned'] as const) {
      const entry = order.get(section)
      if (!entry) continue
      items.push({ kind: 'header', section, id: inboxHeaderId(section) })
      if (collapsed[section]) continue
      entry.rowIds.forEach((threadId, index) => {
        ids.push(threadId)
        items.push({
          kind: section === 'New senders' ? 'sender' : 'thread',
          section,
          id: section === 'New senders' ? `sender:${entry.ids[index]}` : `thread:${threadId}`,
          threadId,
        })
      })
    }
    previousLayout = shareReply(previousLayout, { items, ids })
    return previousLayout
  }
}

export function useInboxSections({
  scope,
  storageKey,
  enabled,
}: {
  scope: string
  storageKey: string
  enabled: boolean
}) {
  const bucketOrder = useBucketOrder(enabled)
  const [preferences, setPreferences] = useState(() => ({
    storageKey,
    value: readPreferences(storageKey),
    dirty: false,
  }))
  if (preferences.storageKey !== storageKey) {
    setPreferences({ storageKey, value: readPreferences(storageKey), dirty: false })
  }
  const [local, setLocal] = useState<{ scope: string; sender: string | null }>({
    scope,
    sender: null,
  })
  if (local.scope !== scope) setLocal({ scope, sender: null })
  const senderId = local.scope === scope ? local.sender : null
  const collapsed = preferences.value

  const readLayout = useMemo(
    () => (senderId === null ? inboxLayoutSelector(collapsed, bucketOrder) : () => undefined),
    [collapsed, bucketOrder, senderId],
  )
  const readIds = useCallback(
    (data: ThreadIndex | undefined) => {
      if (!data?.inbox) return undefined
      return senderId === null
        ? readLayout(data)?.ids
        : (data.inbox.cards.get(senderId)?.threadIds ?? NO_IDS)
    },
    [readLayout, senderId],
  )
  const lastOrder = useRef<{ scope: string; ids: readonly string[] } | null>(null)
  const getPreviousOrder = useCallback(() => {
    const previous = lastOrder.current
    return previous?.scope === scope ? previous.ids : undefined
  }, [scope])
  const focus = useRef<InboxFocus | null>(null)

  useEffect(() => {
    if (!preferences.dirty) return
    try {
      localStorage.setItem(preferences.storageKey, JSON.stringify(preferences.value))
    } catch (error) {
      recordCaughtFailure(error)

      // Disclosures still work when local storage is unavailable.
    }
  }, [preferences])
  const toggle = useCallback((section: InboxSection) => {
    setPreferences((current) => ({
      ...current,
      dirty: true,
      value: { ...current.value, [section]: !current.value[section] },
    }))
  }, [])
  const openSender = useCallback((sender: string | null) => {
    setLocal((current) => ({ ...current, sender }))
  }, [])
  return {
    readIds,
    readLayout,
    lastOrder,
    getPreviousOrder,
    scope,
    collapsed,
    toggle,
    senderId,
    openSender,
    focus,
  }
}

export type InboxNavigation = ReturnType<typeof useInboxSections>
