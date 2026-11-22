import { z } from 'zod'

export const SCREENED_OUT_LABEL = 'Screened out'
export const FILTERED_LABEL = 'Filtered'
export const SenderStatus = z.enum(['unresolved', 'new', 'known', 'blocked'])
export type SenderStatus = z.infer<typeof SenderStatus>
export const ScreeningDisposition = z.enum(['pending', 'screened', 'failed', 'returned'])
export const InboxSender = z.object({
  accountId: z.string(),
  address: z.string(),
  messageId: z.string(),
  status: SenderStatus,
  revision: z.number().int().nonnegative(),
})
export type InboxSender = z.infer<typeof InboxSender>

const id = z.string().min(1).max(512)
export const OwnerReason = z
  .string()
  .trim()
  .max(500)
  .regex(/^[^\r\n]*$/)
export const OwnerActionReasonInput = z.object({ reason: OwnerReason })
export const FilterReviewInput = z.object({
  threadId: id,
  decision: z.enum(['filtered', 'not filtered']),
  expectedRevision: z.number().int().nonnegative(),
  clientActionId: z.uuid(),
  reason: OwnerReason.optional(),
  source: z.enum(['triage-key', 'thread-action']).optional(),
})
export type FilterReviewInput = z.infer<typeof FilterReviewInput>
export interface FilteredPage {
  threads: { id: string; accountId: string; revision: number }[]
  cursor: string | null
}

export interface FilterCounts {
  autoFiltered: number
  restored: number
}
export interface FilterCorrectionPage {
  corrections: {
    actionId: string
    accountId: string
    decision: string
    reason: string | null
    source: string
    createdAt: number
    superseded: boolean
  }[]
  cursor: string | null
}

export const SenderDecision = z.object({
  accountId: id,
  address: id,
  decision: z.enum(['accept', 'block', 'clear']),
  expectedRevision: z.number().int().nonnegative(),
  clientActionId: z.uuid(),
  reason: OwnerReason.optional(),
  source: z.enum(['triage-key', 'thread-action']).optional(),
})
export type SenderDecision = z.infer<typeof SenderDecision>

export const AdoptScreenedDestination = z.object({
  accountId: id,
  providerId: id,
  destination: z.literal('filtered').optional(),
})
export type AdoptScreenedDestination = z.infer<typeof AdoptScreenedDestination>
export const SenderListQuery = z.object({
  accountId: id.optional(),
  status: SenderStatus.optional(),
  cursor: z.string().max(2048).optional(),
  limit: z.coerce.number().int().min(1).max(100).default(50),
})
export type SenderListQuery = z.infer<typeof SenderListQuery>

export interface SenderSuggestion {
  actionId: string
  author: string
  messageId: string
  decision: 'accept' | 'block'
  reason: string
}
export interface SenderList {
  rows: (Omit<InboxSender, 'messageId'> & { suggestions: SenderSuggestion[]; reason?: string })[]
  cursor: string | null
}

export type OwnerActionState = 'pending' | 'applied' | 'superseded' | 'partial' | 'failed'
export interface OwnerActionStatus {
  actionId: string
  accountId: string
  kind: string
  status: OwnerActionState
  revision?: number
  ownerReason?: string | null
  error: string | null
  mutationIds: string[]
  undo: { status: OwnerActionState; error: string | null; mutationIds: string[] } | null
}

export const SenderAvatarResolve = z.object({
  messages: z
    .array(z.object({ accountId: id, messageId: id }))
    .min(1)
    .max(100),
})
export type SenderAvatarResolve = z.infer<typeof SenderAvatarResolve>
export interface SenderAvatarResolution {
  accountId: string
  messageId: string
  initials: string
  color: string
  source: 'initials' | 'bimi' | 'favicon'
  digest: string | null
}
export interface SenderAvatarResults {
  rows: SenderAvatarResolution[]
}

export const TriageQueueQuery = z.object({
  accountId: id.optional(),
  cursor: z.string().max(2048).optional(),
  limit: z.coerce.number().int().min(1).max(100).default(100),
  threadId: id.optional(),
  senderAddress: id.optional(),
  nextBatch: z.enum(['1']).optional(),
  omitThreads: z
    .string()
    .max(52000)
    .refine((raw) => {
      try {
        return z.array(id).max(100).safeParse(JSON.parse(raw)).success
      } catch {
        return false
      }
    }, 'Invalid omitted Threads')
    .optional(),
})
export type TriageQueueQuery = z.infer<typeof TriageQueueQuery>
export type TriageQueueRequest = z.input<typeof TriageQueueQuery>
export type TriageCardId =
  | { kind: 'sender'; accountId: string; address: string }
  | { kind: 'thread'; threadId: string }
export interface TriageQueuePage {
  reviewLookup?: true
  revision: number
  cards: {
    id: TriageCardId
    accountId: string
    messageId: string
    threadId: string
    revision: number
    threadRevision: number
    reason: string
    suggestFilter?: true
    suggestions?: SenderSuggestion[]
  }[]
  cursor: string | null
}
