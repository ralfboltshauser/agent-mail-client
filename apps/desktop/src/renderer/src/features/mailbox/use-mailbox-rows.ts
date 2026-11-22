import type { SearchHit, ThreadSummary } from '@amc/protocol'
import { useMemo } from 'react'
import { threadListQuery } from '@/data/thread-queries'
import { useReplicaSelector } from '@/hooks/use-amc'
import { getAmc } from '@/lib/amc'
import type { View } from '../../../../shared/api'
import { filterQuery, searchSummariesQuery } from '../search/search-queries'
import { forEngine } from './mailbox-queries'

export const NO_THREAD_IDS: readonly string[] = []

export function useMailboxRows({
  engineUrl,
  view,
  accountId,
  filter,
  hits,
  searching,
}: {
  engineUrl: string | null
  view: View
  accountId: string | null
  filter: string
  hits: SearchHit[] | null
  searching: boolean
}) {
  const sectioned = view.kind === 'inbox' && !searching && !filter
  const query = useMemo(() => {
    if (searching) {
      const summaries = hits && searchSummariesQuery(accountId, hits)
      return summaries ? forEngine(engineUrl, summaries) : null
    }
    if (view.kind === 'drafts' || view.kind === 'outbox') return null
    return forEngine(
      engineUrl,
      filter
        ? filterQuery(filter, accountId, view)
        : threadListQuery(getAmc(), { view, accountId }, sectioned),
    )
  }, [searching, hits, accountId, view, filter, engineUrl, sectioned])
  const replicaIds = useReplicaSelector(
    searching || sectioned ? null : query,
    (snapshot) => snapshot.data?.ids,
  )
  const searchRows = useMemo(() => {
    if (!hits) return undefined
    return {
      ids: hits.map(({ id }) => id),
      summaries: new Map<string, ThreadSummary>(hits.map((hit) => [hit.id, hit])),
      snippets: new Map(hits.map(({ id, matchSnippet }) => [id, matchSnippet])),
    }
  }, [hits])
  return { query, ids: searching ? searchRows?.ids : replicaIds, searchRows }
}
