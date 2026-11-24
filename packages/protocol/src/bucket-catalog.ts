import { z } from 'zod'
import { Bucket, BucketAssignment, BucketReason, bucketLabels } from './buckets.ts'
import { BucketId, CustomBucketId } from './decision-labels.ts'
import { OwnerReason } from './smart-inbox.ts'

export const MAX_CUSTOM_BUCKETS = 50
export const BucketStorageKey = z.union([Bucket, CustomBucketId])
export type BucketStorageKey = z.infer<typeof BucketStorageKey>

export function bucketIdForKey(key: BucketStorageKey): z.infer<typeof BucketId> {
  return key in bucketLabels ? bucketLabels[key as Bucket] : (key as z.infer<typeof CustomBucketId>)
}

export const BucketDefinition = z.object({
  id: BucketId,
  name: z.string(),
  description: z.string(),
  builtIn: z.boolean(),
  archived: z.boolean(),
  automatic: z.boolean(),
  classificationRevision: z.number().int().nonnegative(),
})
export type BucketDefinition = z.infer<typeof BucketDefinition>
export const BUILT_IN_BUCKETS: readonly BucketDefinition[] = Bucket.options.map((name) => ({
  id: bucketLabels[name],
  name,
  description: '',
  builtIn: true,
  archived: false,
  automatic: true,
  classificationRevision: 0,
}))

export const BucketCatalog = z.object({
  revision: z.number().int().nonnegative(),
  definitions: z.array(BucketDefinition),
})
export type BucketCatalog = z.infer<typeof BucketCatalog>

const fields = {
  name: z
    .string()
    .trim()
    .min(1)
    .max(60)
    .regex(/^[^\p{Cc}]+$/u),
  description: z.string().trim().max(500),
  automatic: z.boolean(),
}
const expectedRevision = z.number().int().nonnegative()
export const CreateBucket = z.strictObject({
  ...fields,
  description: fields.description.default(''),
  automatic: z.boolean().default(false),
  requestId: z.uuid(),
})
export const UpdateBucket = z.strictObject({
  name: fields.name.optional(),
  description: fields.description.optional(),
  automatic: fields.automatic.optional(),
  archived: z.boolean().optional(),
  expectedRevision,
})
export const ReorderBuckets = z.strictObject({
  ids: z.array(CustomBucketId).max(MAX_CUSTOM_BUCKETS),
  expectedRevision,
})
export const BucketByIdInput = z.strictObject({
  threadId: z.string().min(1),
  bucketId: BucketId.nullable(),
  reason: BucketReason,
})
export const OwnerBucketByIdInput = BucketByIdInput.extend({
  ownerReason: OwnerReason.optional(),
  clientActionId: z.uuid().optional(),
  expectedRevision: expectedRevision.optional(),
})
export const BucketByIdReviewInput = OwnerBucketByIdInput.extend({
  intent: z.literal('review'),
  bucketId: BucketId,
  clientActionId: z.uuid(),
  expectedRevision,
  predictionId: z.string().min(1).max(512).optional(),
  expectedBucketTarget: z
    .object({
      messageId: z.string().min(1).max(512),
      revision: z.string().nullable(),
    })
    .optional(),
})
export const BucketAssignmentById = BucketAssignment.omit({ bucket: true }).extend({
  bucketId: BucketId,
})

export const BucketCatalogEdit = z.discriminatedUnion('kind', [
  z.object({ kind: z.literal('create'), input: CreateBucket }),
  z.object({ kind: z.literal('update'), id: CustomBucketId, input: UpdateBucket }),
  z.object({ kind: z.literal('reorder'), input: ReorderBuckets }),
])
