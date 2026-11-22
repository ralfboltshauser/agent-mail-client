import { z } from 'zod'

export const BUCKETS = [
  'Reply',
  'Action',
  'Follow-up',
  'Update',
  'Later',
  'When I have time',
] as const
export const Bucket = z.enum(BUCKETS)
export type Bucket = z.infer<typeof Bucket>
export const TriageOutcome = z.enum([...BUCKETS, 'filtered'])
export const TriageAttention = z.enum(['routine', 'interrupt', 'security', 'uncertain'])

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
export type BucketInput = z.infer<typeof BucketInput>

export const BucketReviewInput = BucketInput.extend({
  intent: z.literal('review'),
  bucket: Bucket,
  expectedRevision: z.number().int().nonnegative(),
  clientActionId: z.uuid(),
})
export type BucketReviewInput = z.infer<typeof BucketReviewInput>

export const TriageBucketResult = z.object({
  inputRevision: z.number().int().nonnegative(),
  confidence: BucketConfidence.optional(),
  outcome: z.literal('filtered').optional(),
  attention: TriageAttention.optional(),
  version: z
    .string()
    .regex(/^[a-zA-Z0-9:._/-]{1,120}$/)
    .optional(),
})

export type TriageBucketResult = z.infer<typeof TriageBucketResult>

export const BucketAssignment = z.object({
  bucket: Bucket,
  reason: BucketReason,
  setBy: z.string(),
  setAt: z.number(),
  confidence: BucketConfidence.nullable().optional(),
})
