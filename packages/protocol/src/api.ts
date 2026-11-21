import { z } from 'zod'
import { ACCOUNT_STATUSES } from './mail.ts'
import { SCOPES, TOKEN_KINDS } from './scopes.ts'

export const PairRequest = z.object({
  code: z.string().min(6).max(32),
  deviceName: z.string().min(1).max(100),
})
export type PairRequest = z.infer<typeof PairRequest>

export const PairResponse = z.object({
  token: z.string(),
  kind: z.enum(TOKEN_KINDS),
  scopes: z.array(z.enum(SCOPES)),
})
export type PairResponse = z.infer<typeof PairResponse>

export const Me = z.object({
  tokenId: z.string(),
  kind: z.enum(TOKEN_KINDS),
  name: z.string(),
  scopes: z.array(z.enum(SCOPES)),
  features: z.object({ snooze: z.boolean() }).optional(),
})
export type Me = z.infer<typeof Me>

export const PublicHealth = z.object({
  ok: z.boolean(),
  version: z.string(),
})
export type PublicHealth = z.infer<typeof PublicHealth>

export const Health = PublicHealth.extend({
  uptimeSeconds: z.number(),
  schemaVersion: z.number(),
  database: z.object({ path: z.string(), bytes: z.number() }),
  lastBackup: z.object({ at: z.number(), bytes: z.number() }).nullable().optional(),
  accounts: z
    .array(
      z.object({
        address: z.string(),
        status: z.enum(ACCOUNT_STATUSES),
        syncLagSeconds: z.number().nullable(),
        lastError: z.string().nullable(),
      }),
    )
    .optional(),
  outboxDepth: z.number().optional(),
  mutationQueueDepth: z.number().optional(),
  disks: z.array(z.object({ path: z.string(), freeBytes: z.number(), totalBytes: z.number() })),
})
export type Health = z.infer<typeof Health>

export const ApiError = z.object({ error: z.string(), message: z.string() })
export type ApiError = z.infer<typeof ApiError>
