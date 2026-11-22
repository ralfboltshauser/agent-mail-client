import type { ThreadSummary } from '@amc/protocol'
import type { AmcApi, ThreadQuery, ThreadWithMessages } from '../../../shared/api'
import type { ReplicaQuery } from './query-cache'
import { shareReply } from './share-reply'

export interface ThreadIndex {
  ids: readonly string[]
  summaries: ReadonlyMap<string, ThreadSummary>
}

function indexThreads(previous: ThreadIndex | undefined, rows: ThreadSummary[]): ThreadIndex {
  const ids: string[] = []
  const summaries = new Map<string, ThreadSummary>()
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
): ReplicaQuery<ThreadIndex> {
  const { view, accountId, limit } = query
  const viewId = view.kind === 'bucket' ? view.bucket : view.kind === 'label' ? view.labelId : null
  return {
    key: JSON.stringify(['threads', accountId, view.kind, viewId, limit]),
    load: async (previous) => indexThreads(previous, await api.threads(query)),
    isEmpty: (index) => index.ids.length === 0,
    retainDuringBootstrap: 'defer-reads',
  }
}

export function threadDetailQuery(
  api: Pick<AmcApi, 'thread'>,
  id: string,
): ReplicaQuery<ThreadWithMessages | null> {
  return {
    key: JSON.stringify(['thread', id]),
    load: () => api.thread(id),
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
