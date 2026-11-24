import { z } from 'zod'
import { BucketDecisionLabel, BucketId, FilterDecisionLabel } from './decision-labels.ts'
import { OwnerReason } from './smart-inbox.ts'

export const BUCKETS = [
  'Reply',
  'Action',
  'Follow-up',
  'Update',
  'Later',
  'When I have time',
  'Newsletters',
] as const
export const Bucket = z.enum(BUCKETS)
export type Bucket = z.infer<typeof Bucket>
export const TriageProtection = z.enum([
  'routine',
  'interrupt',
  'security',
  'account',
  'billing',
  'uncertain',
])
export const bucketLabels = {
  Reply: 'bucket.reply',
  Action: 'bucket.action',
  'Follow-up': 'bucket.follow_up',
  Update: 'bucket.update',
  Later: 'bucket.later',
  'When I have time': 'bucket.when_i_have_time',
  Newsletters: 'bucket.newsletters',
} as const satisfies Record<Bucket, z.infer<typeof BucketDecisionLabel>>

export const BucketReason = z
  .string()
  .trim()
  .min(1)
  .max(500)
  .regex(/^[^\r\n]+$/)
export const TRIAGE_RECENT_WINDOW_MS = 24 * 60 * 60_000

export const UntriagedLimit = z.number().int().min(1).max(100).default(25)

export const BucketConfidence = z.enum(['low', 'medium', 'high'])
export type BucketConfidence = z.infer<typeof BucketConfidence>

export const BucketInput = z.object({
  threadId: z.string().min(1),
  bucket: Bucket.nullable(),
  reason: BucketReason,
})
export const OwnerBucketInput = BucketInput.extend({
  ownerReason: OwnerReason.optional(),
  clientActionId: z.uuid().optional(),
  expectedRevision: z.number().int().nonnegative().optional(),
})
export type OwnerBucketInput = z.infer<typeof OwnerBucketInput>
export type BucketInput = z.infer<typeof BucketInput>

export const BucketReviewInput = OwnerBucketInput.extend({
  intent: z.literal('review'),
  predictionId: z.string().min(1).max(512).optional(),
  expectedBucketTarget: z
    .object({
      messageId: z.string().min(1).max(512),
      revision: z.string().nullable(),
    })
    .optional(),
  bucket: Bucket,
  expectedRevision: z.number().int().nonnegative(),
  clientActionId: z.uuid(),
})
export type BucketReviewInput = z.infer<typeof BucketReviewInput>

export const TriageBucketResult = z.object({
  inputRevision: z.number().int().nonnegative(),
  confidence: BucketConfidence.optional(),
})

const prediction = {
  confidence: BucketConfidence,
  matchedRuleRevisionId: z.null(),
}
export const TriageBucketPrediction = z.strictObject({
  ...prediction,
  labelId: BucketId,
  displayReason: BucketReason,
})
export const TriageOutputs = z.strictObject({
  bucket: z
    .strictObject({
      ...prediction,
      labelId: BucketDecisionLabel.exclude(['bucket.clear']),
      displayReason: BucketReason,
    })
    .nullable(),
  filter: z.strictObject({ ...prediction, labelId: FilterDecisionLabel }).nullable(),
  protection: TriageProtection,
})
export const CatalogTriageOutputs = TriageOutputs.extend({
  bucket: TriageBucketPrediction.nullable(),
})
export const TriageInputReference = z.strictObject({
  threadId: z.string().min(1).max(512),
  messageId: z.string().min(1).max(512),
  arrivalKey: z.string().min(1).max(512),
  inputRevision: z.number().int().nonnegative(),
})
export type TriageInputReference = z.infer<typeof TriageInputReference>
const producerField = z.string().regex(/^[a-zA-Z0-9:._/-]{1,120}$/)
export const SubmitTriagePrediction = z.strictObject({
  receipt: z.string().min(1).max(131072),
  runId: z.uuid(),
  input: TriageInputReference,
  producer: z.strictObject({
    harnessId: producerField,
    modelId: producerField.nullable(),
    adapterVersion: producerField,
    promptVersion: producerField,
  }),
  outputs: CatalogTriageOutputs,
})
export type SubmitTriagePrediction = z.infer<typeof SubmitTriagePrediction>

export type TriageBucketResult = z.infer<typeof TriageBucketResult>

export const BucketAssignment = z.object({
  bucket: Bucket,
  reason: BucketReason,
  setBy: z.string(),
  setAt: z.number(),
  confidence: BucketConfidence.nullable().optional(),
})
