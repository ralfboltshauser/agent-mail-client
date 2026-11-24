import { MAIL_SEARCH_PAGE_SIZE, type SearchHit } from '@amc/protocol'
import { threadBucketKey } from '@/data/buckets'
import type { ReplicaQuery } from '@/data/query-cache'
import { shareReply } from '@/data/share-reply'
import type { ThreadIndex } from '@/data/thread-queries'
import { getAmc } from '@/lib/amc'
import type { DesktopThreadSummary, View } from '../../../../shared/api'

function indexRows(rows: DesktopThreadSummary[], previous?: ThreadIndex): ThreadIndex {
  const ids = shareReply(
    previous?.ids,
    rows.map(({ id }) => id),
  )
  const summaries = new Map<string, DesktopThreadSummary>()
  let sameSummaries = previous?.summaries.size === rows.length
  for (const row of rows) {
    const prior = previous?.summaries.get(row.id)
    const summary = shareReply(prior, row)
    sameSummaries = sameSummaries && summary === prior
    summaries.set(row.id, summary)
  }
  return { ids, summaries: sameSummaries && previous ? previous.summaries : summaries }
}

export function filterQuery(
  text: string,
  accountId: string | null,
  view: View,
): ReplicaQuery<ThreadIndex> {
  const bucket = view.kind === 'bucket' ? view.bucket : null
  return {
    key: JSON.stringify(['filter', accountId, text, bucket]),
    load: async (previous) => {
      const rows = await getAmc().filter(text, accountId)
      return indexRows(
        bucket ? rows.filter((row) => threadBucketKey(row) === bucket) : rows,
        previous,
      )
    },
    isEmpty: ({ ids }) => ids.length === 0,
    retainDuringBootstrap: 'defer-reads',
  }
}

export function searchSummariesQuery(
  accountId: string | null,
  hits: readonly SearchHit[],
): ReplicaQuery<ThreadIndex> | null {
  if (hits.length === 0) return null
  const ids = hits.map(({ id }) => id)
  return {
    key: JSON.stringify(['search-summaries', accountId, ids]),
    load: async (previous) => {
      // The replica endpoint caps each request at 100 IDs.
      const pages: Promise<DesktopThreadSummary[]>[] = []
      for (let i = 0; i < ids.length; i += MAIL_SEARCH_PAGE_SIZE * 2) {
        pages.push(getAmc().summaries(ids.slice(i, i + MAIL_SEARCH_PAGE_SIZE * 2)))
      }
      return indexRows((await Promise.all(pages)).flat(), previous)
    },
    isEmpty: ({ ids }) => ids.length === 0,
    retainDuringBootstrap: 'defer-reads',
  }
}
