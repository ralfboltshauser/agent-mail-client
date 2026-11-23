import { AsyncLocalStorage } from 'node:async_hooks'
import { join } from 'node:path'
import {
  createLogger,
  type EventFields,
  isCorrelationId,
  newRequestId,
  type RequestId,
  type RunId,
  resolveLogLevel,
  sanitizeError,
} from '@amc/observability'
import { cliLogDirectory, rotatingFileSink, stackFilePaths } from '@amc/observability/node'

type Failure = EventFields<'cli.command.failed'>
export const cliContext = new AsyncLocalStorage<{
  command: Failure['command']
  runId?: RunId
  requestId?: RequestId
}>()

const sinks = new Map<'cli' | 'mcp', ReturnType<typeof rotatingFileSink>>()
export function clientLog(component: 'cli' | 'mcp') {
  let sink = sinks.get(component)
  if (!sink) {
    sink = rotatingFileSink(join(cliLogDirectory(), `${component}.log`), { coordinate: true })
    sinks.set(component, sink)
  }
  return createLogger({
    component,
    sink,
    level: resolveLogLevel(process.env.AMC_LOG_LEVEL),
    stackFiles: stackFilePaths([
      [new URL(import.meta.url), 'cli/entry'],
      [new URL('./main.ts', import.meta.url), 'cli/main'],
      [new URL('./client.ts', import.meta.url), 'cli/client'],
      [new URL('./mcp.ts', import.meta.url), 'cli/mcp'],
      [new URL('./drafts.ts', import.meta.url), 'cli/drafts'],
      [new URL('./mail-commands.ts', import.meta.url), 'cli/mail-commands'],
      [new URL('./triage.ts', import.meta.url), 'cli/triage'],
      [new URL('./triage-claude.ts', import.meta.url), 'cli/triage-claude'],
      [new URL('./smart-inbox.ts', import.meta.url), 'cli/smart-inbox'],
    ]),
  })
}

export async function closeClientLogs() {
  const pending = [...sinks.values()]
  sinks.clear()
  await Promise.all(pending.map((sink) => sink.close()))
}

export function cliRequestId() {
  const requestId = newRequestId()
  const context = cliContext.getStore()
  if (context) context.requestId = requestId
  return requestId
}

const failureSources = new WeakMap<Error, unknown>()
export function retainFailureSource(error: Error, source: unknown) {
  if (source !== undefined) failureSources.set(error, source)
  return error
}

export function cliFailure(
  operation: Failure['operation'],
  err: unknown,
  status?: Failure['status'],
) {
  const ctx = cliContext.getStore()
  if (err instanceof Error) err = failureSources.get(err) ?? err
  const failure = err as { status?: number; requestId?: RequestId; cause?: unknown } | null
  const cause = failure?.cause as typeof failure
  const httpStatus = failure?.status ?? cause?.status
  const candidate = failure?.requestId ?? cause?.requestId
  const requestId = isCorrelationId(candidate)
    ? (candidate as RequestId)
    : (ctx?.requestId ?? newRequestId())
  status ??=
    httpStatus === 0 ? 'unavailable' : httpStatus && httpStatus < 500 ? 'rejected' : 'failed'
  const classified = failure?.status === 0 ? (failure.cause ?? err) : err
  const runId = ctx?.runId
  clientLog('cli').log(
    operation === 'command' ? 'error' : 'warn',
    'cli.command.failed',
    { operation, command: ctx?.command ?? 'triage', status, err: classified },
    { requestId, runId },
  )
  return {
    class: sanitizeError(classified).class,
    id: runId ? `run ${runId}` : `request ${requestId}`,
  }
}
