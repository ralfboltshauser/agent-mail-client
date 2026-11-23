import { clientEvents } from './client-events.ts'
import { desktopEvents } from './desktop-events.ts'
import { engineEvents } from './engine-events.ts'
import { isCorrelationId, type RequestId, type RunId } from './ids.ts'

const operations = [
  'triage.run',
  'sync.cycle',
  'sync.imap.action',
  'deploy.migration',
  'feedback.launch',
  'handoff',
] as const
export type Operation = (typeof operations)[number]

type Rule = 'route' | 'status' | 'duration' | 'count' | 'boolean' | 'error' | readonly string[]
export type FieldRule = Exclude<Rule, 'error'>
type EventSpec = {
  fields: Readonly<Record<string, Rule>>
  message?: (fields: Readonly<Record<string, unknown>>) => string
}

// Add an event here to declare its complete writable payload. Strings are
// explicitly enumerated except route templates, which require membership in
// the logger's trusted set of registered routes. "error" invokes serialization.
export const events = {
  ...engineEvents,
  ...desktopEvents,
  ...clientEvents,
  'span.started': { fields: { operation: operations } },
  'span.finished': {
    fields: {
      operation: operations,
      outcome: ['ok', 'error'],
      durationMs: 'duration',
      err: 'error',
    },
  },
} as const satisfies Record<string, EventSpec>

export const scopeRules = {
  requestId: isCorrelationId,
  runId: isCorrelationId,
  accountId: (value: unknown): value is string =>
    typeof value === 'string' && value.length === 16 && /^acc_[A-Za-z0-9_-]{12}$/.test(value),
}
export interface LogScope {
  requestId?: RequestId
  runId?: RunId
  accountId?: string
}

export type EventName = keyof typeof events
type FieldValue<R> = R extends readonly string[]
  ? R[number]
  : R extends 'route'
    ? string
    : R extends 'status' | 'duration' | 'count'
      ? number
      : R extends 'boolean'
        ? boolean
        : R extends 'error'
          ? unknown
          : never

type Fields<N extends EventName> = (typeof events)[N]['fields']
export type EventFields<N extends EventName> = {
  [K in keyof Fields<N> as K extends 'err' ? never : K]: FieldValue<Fields<N>[K]>
} & {
  [K in keyof Fields<N> as K extends 'err' ? K : never]?: FieldValue<Fields<N>[K]>
}

/** Renderer sends metadata only. Main authenticates the sender and logs these fields. */
export const RENDERER_LOG_CHANNEL = 'amc:observability' as const
export type RendererLogReport = EventFields<'renderer.failure'> &
  Pick<LogScope, 'requestId' | 'runId'>
