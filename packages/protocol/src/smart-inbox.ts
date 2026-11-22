import { z } from 'zod'

export const SCREENED_OUT_LABEL = 'Screened out'
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
export const SenderDecision = z.object({
  accountId: id,
  address: id,
  decision: z.enum(['accept', 'block', 'clear']),
  expectedRevision: z.number().int().nonnegative(),
  clientActionId: z.uuid(),
})
export type SenderDecision = z.infer<typeof SenderDecision>

export const AdoptScreenedDestination = z.object({ accountId: id, providerId: id })
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
  rows: (Omit<InboxSender, 'messageId'> & { suggestions: SenderSuggestion[] })[]
  cursor: string | null
}

export type OwnerActionState = 'pending' | 'applied' | 'superseded' | 'partial' | 'failed'
export interface OwnerActionStatus {
  actionId: string
  accountId: string
  kind: string
  status: OwnerActionState
  revision?: number
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
})
export type TriageQueueQuery = z.infer<typeof TriageQueueQuery>
export type TriageCardId =
  | { kind: 'sender'; accountId: string; address: string }
  | { kind: 'thread'; threadId: string }
export interface TriageQueuePage {
  revision: number
  cards: {
    id: TriageCardId
    accountId: string
    messageId: string
    threadId: string
    revision: number
    threadRevision: number
    reason: string
  }[]
  cursor: string | null
}
