import { errorClasses } from '@amc/observability'
import { z } from 'zod'

const count = z.number().int().nonnegative()
const timestamp = z.iso.datetime()
const accountId = z.string().regex(/^acc_[A-Za-z0-9_-]{12}$/)

export const DiagnosticStatus = z.object({
  lastSuccessAt: timestamp.nullable(),
  lastFailure: z.object({ at: timestamp, errorClass: z.enum(errorClasses) }).nullable(),
  successes: count,
  failures: count,
})
export type DiagnosticStatus = z.infer<typeof DiagnosticStatus>

export const Diagnostics = z.object({
  version: z.string().regex(/^(?:dev|[0-9]+\.[0-9]+\.[0-9]+)$/),
  schemaVersion: count,
  uptimeSeconds: count,
  queues: z.object({ mutations: count, outbox: count, purge: count }),
  syncAccounts: z.array(z.object({ accountId, status: DiagnosticStatus })),
  imapIdle: z.array(z.object({ accountId, status: DiagnosticStatus })),
  pubSub: DiagnosticStatus,
  purge: DiagnosticStatus,
  outbox: DiagnosticStatus,
  migrations: DiagnosticStatus,
})
export type Diagnostics = z.infer<typeof Diagnostics>
