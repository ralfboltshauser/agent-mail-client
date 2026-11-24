import { type BucketDefinition, bucketIdForKey, type ThreadSummary } from '@amc/protocol'
import type { AmcApi, DesktopThreadSummary, ThreadQuery } from '../../../shared/api'
import type { ReplicaQuery } from './query-cache'
import { shareReply } from './share-reply'

export interface ThreadIndex {
  inbox?: InboxIndex
  ids: readonly string[]
  summaries: ReadonlyMap<string, DesktopThreadSummary>
}

function indexThreads(
  previous: ThreadIndex | undefined,
  rows: DesktopThreadSummary[],
): ThreadIndex {
  const ids: string[] = []
  const summaries = new Map<string, DesktopThreadSummary>()
  let changed = previous?.summaries.size !== rows.length
  for (const row of rows) {
    ids.push(row.id)
    const prior = previous?.summaries.get(row.id)
    const next = shareReply(prior, row)
    summaries.set(row.id, next)
    changed ||= next !== prior
  }
  const order = shareReply(previous?.ids, ids)
  if (previous && !changed && order === previous.ids) return previous
  return { ids: order, summaries: !changed && previous ? previous.summaries : summaries }
}

export function threadListQuery(
  api: Pick<AmcApi, 'threads'>,
  query: ThreadQuery,
  sectioned = false,
): ReplicaQuery<ThreadIndex> {
  const { view, accountId, limit } = query
  const viewId = view.kind === 'bucket' ? view.bucket : view.kind === 'label' ? view.labelId : null
  // Matches the default window in the replica's threads read. SQLite LIMIT -1
  // reads the full effective Inbox when that first window might omit Threads.
  const windowSize = 5000
  const fullInbox = { ...query, limit: -1 }
  return {
    key: JSON.stringify([
      sectioned ? 'inbox-sections' : 'threads',
      accountId,
      view.kind,
      viewId,
      limit,
    ]),
    load: async (previous) => {
      let rows = await api.threads(
        sectioned && (previous?.ids.length ?? 0) >= windowSize ? fullInbox : query,
      )
      if (sectioned && (previous?.ids.length ?? 0) < windowSize && rows.length >= windowSize) {
        rows = await api.threads(fullInbox)
      }
      const index = indexThreads(previous, rows)
      if (!sectioned || index === previous) return index
      return { ...index, inbox: indexInbox(previous, index) }
    },
    isEmpty: (index) => index.ids.length === 0,
    retainDuringBootstrap: 'defer-reads',
  }
}

export function messageTextQuery(
  api: Pick<AmcApi, 'messageText'>,
  id: string,
  bodyRevision: string,
): ReplicaQuery<string | null> {
  return {
    key: JSON.stringify(['message-text', id, bodyRevision]),
    load: async () => {
      const text = await api.messageText(id)
      if (text === null || bodyRevision === '') return text
      // SQLite serves the current body by ID. Verify the revision before caching it.
      const digest = await crypto.subtle.digest('SHA-256', new TextEncoder().encode(text))
      const revision = Array.from(new Uint8Array(digest), (byte) =>
        byte.toString(16).padStart(2, '0'),
      ).join('')
      if (revision !== bodyRevision) throw new Error('Message text changed before it could be read')
      return text
    },
    retainDuringBootstrap: 'defer-reads',
    versioned: bodyRevision !== '',
  }
}

export type InboxSection = BucketDefinition['id'] | 'New senders' | 'Unassigned'

export interface SenderCardData {
  id: string
  address: string
  accountId: string
  name: string
  subject: string
  representativeId: string
  messageId?: string
  threadIds: readonly string[]
  unread: boolean
}

interface InboxSectionData {
  rowIds: readonly string[]
  ids: readonly string[]
  unread: number
  count: number
}

interface InboxIndex {
  sections: ReadonlyMap<InboxSection, InboxSectionData>
  cards: ReadonlyMap<string, SenderCardData>
}

function sectionFor(thread: ThreadSummary): InboxSection {
  const sender = thread.inboxSender
  if (sender?.status === 'new' && sender.accountId === thread.accountId) return 'New senders'
  if (thread.bucketAssignment) return thread.bucketAssignment.bucketId
  return thread.bucket ? bucketIdForKey(thread.bucket.bucket) : 'Unassigned'
}

function compareActivity(a: ThreadSummary, b: ThreadSummary) {
  return b.lastMessageAt - a.lastMessageAt || (a.id < b.id ? -1 : Number(a.id > b.id))
}

function compareThreads(a: ThreadSummary, b: ThreadSummary) {
  return Number(b.unreadCount > 0) - Number(a.unreadCount > 0) || compareActivity(a, b)
}

function groupSenders(threads: ThreadSummary[], previous: InboxIndex | undefined) {
  const groups = new Map<string, ThreadSummary[]>()
  for (const thread of threads) {
    const sender = thread.inboxSender
    if (!sender) continue
    const id = JSON.stringify([sender.accountId, sender.address])
    const group = groups.get(id)
    if (group) group.push(thread)
    else groups.set(id, [thread])
  }
  const ordered = Array.from(groups, ([id, group]) => {
    const newest = group.reduce((a, b) => (compareActivity(a, b) <= 0 ? a : b))
    const { accountId, participants, subject } = newest
    const address = newest.inboxSender?.address ?? ''
    const card = shareReply(previous?.cards.get(id), {
      id,
      address,
      accountId,
      name:
        participants.find((person) => person.address.toLowerCase() === address)?.name || address,
      subject,
      representativeId: newest.id,
      messageId: newest.inboxSender?.messageId,
      threadIds: group.sort(compareThreads).map(({ id }) => id),
      unread: group.some((thread) => thread.unreadCount > 0),
    })
    return { card, date: newest.lastMessageAt }
  })
  ordered.sort(
    (a, b) =>
      Number(b.card.unread) - Number(a.card.unread) ||
      b.date - a.date ||
      (a.card.id < b.card.id ? -1 : Number(a.card.id > b.card.id)),
  )
  return new Map(ordered.map(({ card }) => [card.id, card]))
}

function indexInbox(previous: ThreadIndex | undefined, index: ThreadIndex): InboxIndex {
  const prior = previous?.inbox
  const dirty = new Set<InboxSection>()
  for (const [id, thread] of index.summaries) {
    const old = previous?.summaries.get(id)
    if (old === thread) continue
    dirty.add(sectionFor(thread))
    if (old) dirty.add(sectionFor(old))
  }
  for (const [id, thread] of previous?.summaries ?? []) {
    if (!index.summaries.has(id)) dirty.add(sectionFor(thread))
  }
  if (prior && dirty.size === 0) return prior

  const affected = new Map<InboxSection, ThreadSummary[]>()
  for (const section of dirty) affected.set(section, [])
  for (const thread of index.summaries.values()) affected.get(sectionFor(thread))?.push(thread)

  const senders = affected.get('New senders')
  const cards = senders ? groupSenders(senders, prior) : (prior?.cards ?? new Map())
  const sections = new Map(prior?.sections)
  for (const [section, rows] of affected) {
    if (rows.length === 0) {
      sections.delete(section)
      continue
    }
    const old = prior?.sections.get(section)
    const ids =
      section === 'New senders'
        ? Array.from(cards.keys())
        : rows.sort(compareThreads).map(({ id }) => id)
    sections.set(
      section,
      shareReply(old, {
        ids,
        rowIds:
          section === 'New senders'
            ? Array.from(cards.values(), (card) => card.representativeId)
            : ids,
        unread: rows.filter((thread) => thread.unreadCount > 0).length,
        count: ids.length,
      }),
    )
  }
  return { sections, cards }
}
