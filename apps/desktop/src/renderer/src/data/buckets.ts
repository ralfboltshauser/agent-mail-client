import {
  BUILT_IN_BUCKETS,
  Bucket,
  type BucketCatalog,
  type BucketDefinition,
  type BucketStorageKey,
  bucketIdForKey,
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
  const builtin = key && Bucket.safeParse(key)
  const id = key && builtin && !builtin.success ? key : null
  const name = useReplicaSelector(
    id ? catalogQuery : null,
    ({ data }) => data?.definitions.find((item) => item.id === id)?.name,
  )
  return builtin?.success ? builtin.data : id ? (name ?? 'Custom Bucket') : undefined
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

export function bucketSelection(key: BucketStorageKey | null, idAware: boolean) {
  const builtin = Bucket.safeParse(key)
  if (idAware) return { bucketId: key === null ? null : bucketIdForKey(key) }
  return { bucket: builtin.success ? builtin.data : null }
}
