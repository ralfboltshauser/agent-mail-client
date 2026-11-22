import type { AccountSummary, ThreadSummary } from '@amc/protocol'
import type { QuerySnapshot, ReplicaQuery } from '@/data/query-cache'
import { replicaStoreFor } from '@/data/replica-store'
import type { ThreadIndex } from '@/data/thread-queries'
import { getAmc } from '@/lib/amc'
import type { ThreadWithMessages } from '../../../../shared/api'

const duringSnapshot = 'defer-reads' as const

export const accountsQuery = () => ({
  key: 'accounts',
  load: getAmc().accounts,
  retainDuringBootstrap: duringSnapshot,
})

export const labelsQuery = (accountId: string | null) => ({
  key: JSON.stringify(['labels', accountId]),
  load: () => getAmc().labels(accountId),
  retainDuringBootstrap: duringSnapshot,
})

export const countsQuery = (accountId: string | null) => ({
  key: JSON.stringify(['counts', accountId]),
  load: () => getAmc().counts(accountId),
  retainDuringBootstrap: duringSnapshot,
})

/** Fence queued reads owned by a workspace that is being replaced on re-pairing. */
export function forEngine<T>(engineUrl: string | null, query: ReplicaQuery<T>): ReplicaQuery<T> {
  const store = replicaStoreFor(getAmc())
  return {
    ...query,
    key: JSON.stringify([engineUrl, query.key]),
    load: (previous) => {
      if (engineUrl !== store.getStatus().value?.engineUrl) {
        throw new Error('The Engine pairing changed before the mailbox could be read')
      }
      return query.load(previous)
    },
  }
}

export function selectedThreadQuery(
  engineUrl: string | null,
  selected: Pick<ThreadSummary, 'id' | 'accountId'> | undefined,
): ReplicaQuery<ThreadWithMessages | null> | null {
  if (!selected) return null
  const { id, accountId } = selected
  return forEngine(engineUrl, {
    key: JSON.stringify(['thread', accountId, id]),
    load: async () => {
      const detail = await getAmc().thread(id)
      if (detail && (detail.thread.id !== id || detail.thread.accountId !== accountId)) {
        throw new Error('Thread reply does not match the selected thread')
      }
      return detail
    },
    retainDuringBootstrap: duringSnapshot,
  })
}

export const queryFailed = (snapshot: QuerySnapshot<unknown>) =>
  snapshot.state === 'first-error' || snapshot.state === 'cached+error'

export type MailboxThreadQuery = ReplicaQuery<ThreadIndex>
export type MailboxAccount = Pick<AccountSummary, 'id' | 'kind' | 'imapMoves'>
