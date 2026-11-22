import type { SearchHit, ThreadSummary } from '@amc/protocol'
import { useMemo } from 'react'
import { useReplica } from '@/hooks/use-amc'
import { getAmc } from '@/lib/amc'
import type { View } from '../../../../shared/api'
import { useMailboxQuery } from './use-mailbox-query'

export const NO_THREADS: ThreadSummary[] = []

export function useMailboxRows({
  view,
  accountId,
  key,
  filter,
  hits,
  searching,
  snapshotPending,
}: {
  view: View
  accountId: string | null
  key: string
  filter: string
  hits: SearchHit[] | null
  searching: boolean
  snapshotPending: boolean
}) {
  const list = useMailboxQuery(
    key,
    () => (filter ? getAmc().filter(filter, accountId) : getAmc().threads({ view, accountId })),
    !searching && !snapshotPending && view.kind !== 'drafts' && view.kind !== 'outbox',
  )
  const summaries = useReplica(
    async () => (hits ? { hits, rows: await getAmc().summaries(hits.map(({ id }) => id)) } : null),
    [hits],
    null,
  )
  const currentSummaries = summaries?.hits === hits ? summaries.rows : undefined
  const filtered = useMemo(
    () =>
      filter && view.kind === 'bucket'
        ? list.data?.filter((row) => row.bucket?.bucket === view.bucket)
        : list.data,
    [filter, view, list.data],
  )
  const searchRows = useMemo(() => {
    if (!hits) return undefined
    if (!currentSummaries) return hits
    const byId = new Map(currentSummaries.map((summary) => [summary.id, summary]))
    return hits.map((hit) => byId.get(hit.id) ?? hit)
  }, [hits, currentSummaries])
  const matchSnippets = useMemo(
    () => (hits ? new Map(hits.map(({ id, matchSnippet }) => [id, matchSnippet])) : undefined),
    [hits],
  )
  return { list, rows: searching ? searchRows : filtered, matchSnippets }
}
