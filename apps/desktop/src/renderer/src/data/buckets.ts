import {
  BUILT_IN_BUCKETS,
  Bucket,
  type BucketCatalog,
  type BucketDefinition,
  type BucketStorageKey,
  CustomBucketId,
  type ThreadSummary,
} from '@amc/protocol'
import { useReplicaSelector } from '@/hooks/use-amc'
import { getAmc } from '@/lib/amc'
import type { ReplicaQuery } from './query-cache'

const catalogQuery: ReplicaQuery<BucketCatalog | null> = {
  key: 'bucket-catalog',
  load: () => getAmc().bucketCatalog?.() ?? Promise.resolve(null),
  retainDuringBootstrap: 'defer-reads',
}

export const useBucketCatalog = () => useReplicaSelector(catalogQuery, ({ data }) => data)

export function useBucketName(key: BucketStorageKey | null | undefined) {
  const id = key && CustomBucketId.safeParse(key).success ? key : null
  const name = useReplicaSelector(
    id ? catalogQuery : null,
    ({ data }) => data?.definitions.find((item) => item.id === id)?.name,
  )
  return id ? (name ?? 'Custom Bucket') : (key ?? undefined)
}

export function bucketKey(item: BucketDefinition): BucketStorageKey {
  return item.builtIn ? Bucket.parse(item.name) : (item.id as BucketStorageKey)
}

export function activeBuckets(catalog: BucketCatalog | null | undefined) {
  return catalog?.definitions.filter((item) => !item.archived) ?? BUILT_IN_BUCKETS
}

export function threadBucketKey(thread: ThreadSummary | null | undefined): BucketStorageKey | null {
  return (
    (thread?.bucketAssignment?.bucketId as BucketStorageKey | undefined) ??
    thread?.bucket?.bucket ??
    null
  )
}
