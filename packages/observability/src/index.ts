import { type OwnStackFiles, sanitizeError } from './errors.ts'
import {
  type EventFields,
  type EventName,
  events,
  type FieldRule,
  type LogScope,
  type Operation,
  scopeRules,
} from './events.ts'
import { newRunId } from './ids.ts'

export { rendererFailureSources } from './desktop-events.ts'
export {
  type ErrorClass,
  type ErrorCode,
  errorClasses,
  type SafeError,
  sanitizeError,
  sanitizeErrorMessage,
} from './errors.ts'
export {
  type EventFields,
  type EventName,
  type LogScope,
  type Operation,
  RENDERER_LOG_CHANNEL,
  type RendererLogReport,
} from './events.ts'
export {
  fetchWithRequestId,
  isCorrelationId,
  newRequestId,
  newRunId,
  REQUEST_ID_HEADER,
  type RequestId,
  type RunId,
} from './ids.ts'

export {
  type TriageFailureReason,
  triageErrorClasses,
  triageFailureMessages,
} from './triage-diagnostics.ts'

const levels = ['debug', 'info', 'warn', 'error'] as const
export type Level = (typeof levels)[number]
export type Component = 'engine' | 'main' | 'renderer' | 'cli' | 'mcp'
export type Sink = (line: string) => void

export function resolveLogLevel(value: unknown, fallback: Level = 'info'): Level {
  return levels.find((level) => level === value) ?? fallback
}

export interface Logger {
  log<N extends EventName>(
    level: Level,
    event: N,
    fields: EventFields<NoInfer<N>>,
    scope?: LogScope,
  ): void
  with(scope: LogScope): Logger
  span<T>(operation: Operation, fn: (log: Logger) => T | PromiseLike<T>): Promise<T>
}

interface LoggerOptions {
  component: Component
  sink: Sink
  level?: Level
  routes?: ReadonlySet<string>
  stackFiles?: OwnStackFiles
}

function ownValue(object: unknown, key: string): unknown {
  return object && typeof object === 'object'
    ? Object.getOwnPropertyDescriptor(object, key)?.value
    : undefined
}

function safeScope(scope: unknown) {
  try {
    return Object.fromEntries(
      Object.entries(scopeRules).flatMap(([key, valid]) => {
        const value = ownValue(scope, key)
        return valid(value) ? [[key, value]] : []
      }),
    )
  } catch {
    return {}
  }
}

function validField(rule: FieldRule, value: unknown, routes?: ReadonlySet<string>): boolean {
  switch (rule) {
    case 'route':
      return typeof value === 'string' && routes?.has(value) === true
    case 'status':
      return typeof value === 'number' && Number.isInteger(value) && value >= 100 && value <= 599
    case 'duration':
      return typeof value === 'number' && Number.isFinite(value) && value >= 0
    case 'count':
      return typeof value === 'number' && Number.isSafeInteger(value) && value >= 0
    case 'boolean':
      return typeof value === 'boolean'
    default:
      return (rule as readonly unknown[]).includes(value)
  }
}

export function createLogger({
  component,
  sink,
  level = 'info',
  routes,
  stackFiles,
}: LoggerOptions): Logger {
  if (!['engine', 'main', 'renderer', 'cli', 'mcp'].includes(component))
    throw new TypeError('Invalid AMC log component')
  const threshold = levels.indexOf(resolveLogLevel(level))

  function scoped(context: LogScope, spanId?: string, parentSpanId?: string): Logger {
    return {
      log(level, event, fields, scope) {
        const rank = levels.indexOf(level)
        if (rank < threshold || typeof event !== 'string' || !Object.hasOwn(events, event)) return
        try {
          const spec = events[event]
          const payload: Record<string, unknown> = {}
          for (const [key, rule] of Object.entries(spec.fields)) {
            const value = ownValue(fields, key)
            if (rule === 'error') {
              if (value !== undefined) payload[key] = sanitizeError(value, stackFiles)
              continue
            }
            if (!validField(rule, value, routes)) return
            payload[key] = value
          }
          const msg = 'message' in spec ? spec.message(payload) : undefined
          sink(
            JSON.stringify({
              ts: new Date().toISOString(),
              level,
              component,
              event,
              msg,
              ...context,
              ...safeScope(scope),
              spanId,
              parentSpanId,
              ...payload,
            }),
          )
        } catch {
          // A reporting or storage failure must not break the operation being logged.
        }
      },
      with(scope) {
        return scoped({ ...context, ...safeScope(scope) }, spanId, parentSpanId)
      },
      async span(operation, fn) {
        const child = scoped(
          { ...context, runId: context.runId ?? newRunId() },
          globalThis.crypto.randomUUID(),
          spanId,
        )
        const start = performance.now()
        child.log('info', 'span.started', { operation })
        try {
          const result = await fn(child)
          child.log('info', 'span.finished', {
            operation,
            outcome: 'ok',
            durationMs: performance.now() - start,
          })
          return result
        } catch (err) {
          child.log('error', 'span.finished', {
            operation,
            outcome: 'error',
            durationMs: performance.now() - start,
            err,
          })
          throw err
        }
      },
    }
  }
  return scoped({})
}
