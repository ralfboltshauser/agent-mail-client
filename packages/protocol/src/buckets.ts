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

export const BucketReason = z
  .string()
  .trim()
  .min(1)
  .max(500)
  .regex(/^[^\r\n]+$/)
export const UntriagedLimit = z.number().int().min(1).max(100).default(25)

export const BucketInput = z.object({
  threadId: z.string().min(1),
  bucket: Bucket.nullable(),
  reason: BucketReason,
})
export type BucketInput = z.infer<typeof BucketInput>

export const BucketAssignment = z.object({
  bucket: Bucket,
  reason: BucketReason,
  setBy: z.string(),
  setAt: z.number(),
})
