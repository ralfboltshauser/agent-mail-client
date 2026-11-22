import { z } from 'zod'

export const TriageHistoryQuery = z.object({
  accountId: z.string().min(1).max(512).optional(),
  before: z.coerce.number().int().positive().max(Number.MAX_SAFE_INTEGER).optional(),
  limit: z.coerce.number().int().min(1).max(100).default(50),
  includeReasons: z.literal('1').optional(),
})

export const TriageExportInput = z.strictObject({
  accountId: z.string().min(1).max(512).optional(),
  includeReasons: z.boolean().default(false),
})

export type TriageExportInput = z.input<typeof TriageExportInput>

export interface TriageHistoryEvent {
  seq: number
  id: string
  accountId: string
  generation: number | null
  axis: string
  kind: string
  source: string
  labelId: string | null
  at: string
  actionId: string | null
  threadId: string | null
  targetEventId: string | null
  predictionId: string | null
  retracted: boolean
  reasonEditable: boolean
  reason?: string | null
  reasonRevision?: string | null
}

export interface TriageHistoryPage {
  events: TriageHistoryEvent[]
  before: number | null
  legacy: { imported: number; skipped: number; complete: boolean }
}
