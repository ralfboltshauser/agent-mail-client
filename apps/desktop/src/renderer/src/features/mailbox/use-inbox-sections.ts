import { useCallback, useEffect, useMemo, useRef, useState } from 'react'
import { shareReply } from '@/data/share-reply'
import { INBOX_SECTIONS, type InboxSection, type ThreadIndex } from '@/data/thread-queries'
import { recordCaughtFailure } from '@/lib/failure'

export const UPDATES_PREVIEW = 3
const NO_IDS: readonly string[] = []
type CollapsePreferences = Partial<Record<InboxSection, boolean>>

export type InboxItem =
  | { kind: 'header'; section: InboxSection; id: string }
  | { kind: 'sender' | 'thread'; section: InboxSection; id: string; threadId: string }
  | { kind: 'footer'; section: 'Updates'; id: string }

interface InboxFocus {
  jump: (delta: number) => void
  move: (delta: number) => boolean
}

export const inboxHeaderId = (section: InboxSection) => `header:${section}`

function readPreferences(key: string): CollapsePreferences {
  try {
    const stored = JSON.parse(localStorage.getItem(key) ?? '{}')
    return Object.fromEntries(
      INBOX_SECTIONS.filter((section) => stored?.[section] === true).map((section) => [
        section,
        true,
      ]),
    )
  } catch (error) {
    recordCaughtFailure(error)

    return {}
  }
}

// Cache only derived topology, so snapshot reads can share a value across subscribers.
function inboxLayoutSelector(collapsed: CollapsePreferences, showAll: boolean) {
  let previousOrder: NonNullable<ThreadIndex['inbox']>['sections'] | undefined
  let previousLayout: { items: readonly InboxItem[]; ids: readonly string[] } | undefined
  return (data: ThreadIndex | undefined) => {
    const order = data?.inbox?.sections
    if (!order) return undefined
    if (
      previousOrder &&
      INBOX_SECTIONS.every(
        (section) =>
          previousOrder?.[section].ids === order[section].ids &&
          previousOrder[section].rowIds === order[section].rowIds,
      )
    )
      return previousLayout
    previousOrder = order
    const items: InboxItem[] = []
    const ids: string[] = []
    for (const section of INBOX_SECTIONS) {
      const { ids: keys, rowIds } = order[section]
      if (keys.length === 0) continue
      items.push({ kind: 'header', section, id: inboxHeaderId(section) })
      if (collapsed[section]) continue
      const visible =
        section === 'Updates' && !showAll ? Math.min(UPDATES_PREVIEW, keys.length) : keys.length
      for (let i = 0; i < visible; i++) {
        const threadId = rowIds[i]
        ids.push(threadId)
        items.push({
          kind: section === 'New senders' ? 'sender' : 'thread',
          section,
          id: section === 'New senders' ? `sender:${keys[i]}` : `thread:${threadId}`,
          threadId,
        })
      }
      if (section === 'Updates' && keys.length > UPDATES_PREVIEW) {
        items.push({ kind: 'footer', section, id: 'footer:Updates' })
      }
    }
    previousLayout = shareReply(previousLayout, { items, ids })
    return previousLayout
  }
}

export function useInboxSections({ scope, storageKey }: { scope: string; storageKey: string }) {
  const [preferences, setPreferences] = useState(() => ({
    storageKey,
    value: readPreferences(storageKey),
    dirty: false,
  }))
  if (preferences.storageKey !== storageKey) {
    setPreferences({ storageKey, value: readPreferences(storageKey), dirty: false })
  }
  const [local, setLocal] = useState<{ scope: string; showAll: boolean; sender: string | null }>({
    scope,
    showAll: false,
    sender: null,
  })
  if (local.scope !== scope) setLocal({ scope, showAll: false, sender: null })
  const senderId = local.scope === scope ? local.sender : null
  const showAll = local.scope === scope && local.showAll
  const collapsed = preferences.value

  const readLayout = useMemo(
    () => (senderId === null ? inboxLayoutSelector(collapsed, showAll) : () => undefined),
    [collapsed, showAll, senderId],
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
  const toggleUpdates = useCallback(() => {
    setLocal((current) => ({ ...current, showAll: !current.showAll }))
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
    showAll,
    toggleUpdates,
    senderId,
    openSender,
    focus,
  }
}

export type InboxNavigation = ReturnType<typeof useInboxSections>
