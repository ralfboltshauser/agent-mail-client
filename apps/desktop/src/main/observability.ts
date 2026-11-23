import { readFileSync, renameSync, writeFileSync } from 'node:fs'
import { join } from 'node:path'
import {
  createLogger,
  type EventFields,
  type Level,
  type Logger,
  type LogScope,
  newRequestId,
  resolveLogLevel,
} from '@amc/observability'
import { rotatingFileSink, stackFilePaths } from '@amc/observability/node'
import { type FailureDetails, failureDetails, formatFailure } from '../shared/failure'

export type DesktopIpcChannel = EventFields<'desktop.ipc.failed'>['channel']

type Stage = EventFields<'desktop.operation.failed'>['stage']
const noop = () => {}
export let mainLog = createLogger({ component: 'main', sink: noop })
export let rendererLog = createLogger({ component: 'renderer', sink: noop })
export let startupMarkerLog = mainLog

const scopes = new WeakMap<object, FailureDetails>()

export function rememberFailure(error: unknown, details: FailureDetails) {
  if (error && typeof error === 'object') scopes.set(error, details)
  return details
}

export function knownFailure(error: unknown) {
  return error && typeof error === 'object' ? scopes.get(error) : undefined
}

export function failureScope(details: FailureDetails): LogScope {
  return details.kind === 'Run'
    ? { runId: details.id as LogScope['runId'] }
    : { requestId: details.id as LogScope['requestId'] }
}

export function operationFailure(
  stage: Stage,
  err: unknown,
  details = knownFailure(err) ?? failureDetails(err, newRequestId(), 'Request'),
) {
  mainLog.log('error', 'desktop.operation.failed', { stage, err }, failureScope(details))
  return rememberFailure(err, details)
}

export function reportIpcFailure(channel: DesktopIpcChannel, err: unknown): FailureDetails {
  const details = knownFailure(err) ?? failureDetails(err, newRequestId(), 'Request')
  mainLog.log('error', 'desktop.ipc.failed', { channel, err }, failureScope(details))
  return details
}

export function ipcError(channel: DesktopIpcChannel, err: unknown, hint?: string) {
  const details = reportIpcFailure(channel, err)
  return new Error(hint ? `${hint}\n${formatFailure(details)}` : formatFailure(details))
}

export function configureDesktopLogs(directory: string, profile: string, entry: string) {
  const main = rotatingFileSink(join(directory, 'main.log'))
  const renderer = rotatingFileSink(join(directory, 'renderer.log'))
  const stackFiles = stackFilePaths([
    [new URL('./index.js', entry), 'desktop/main/index'],
    [new URL('./triage-worker.js', entry), 'desktop/main/triage-worker'],
    [new URL('./chunks/triage.js', entry), 'desktop/main/chunks/triage'],
  ])
  const path = join(profile, 'debug-logging')
  let debug = false
  function apply(level: Level) {
    mainLog = createLogger({ component: 'main', sink: main, level, stackFiles })
    rendererLog = createLogger({ component: 'renderer', sink: renderer, level })
  }
  startupMarkerLog = createLogger({ component: 'main', sink: main })
  try {
    debug = readFileSync(path, 'utf8') === 'true'
  } catch (error) {
    if ((error as NodeJS.ErrnoException).code !== 'ENOENT') {
      startupMarkerLog.log('error', 'desktop.operation.failed', {
        stage: 'log-settings',
        err: error,
      })
    }
  }
  const level = () => resolveLogLevel(process.env.AMC_LOG_LEVEL, debug ? 'debug' : 'info')
  apply(level())
  return {
    read: () => ({ debug, effectiveLevel: level() }),
    close: () => Promise.all([main.close(), renderer.close()]),
    write(enabled: unknown) {
      if (typeof enabled !== 'boolean') throw new TypeError('Invalid debug preference')
      writeFileSync(`${path}.tmp`, String(enabled), { mode: 0o600 })
      renameSync(`${path}.tmp`, path)
      debug = enabled
      apply(level())
      return this.read()
    },
  }
}

// Long-lived consumers keep this forwarding logger when the preference changes.
export const desktopLogger: Logger = {
  log: (...args) => mainLog.log(...args),
  with: (scope) => mainLog.with(scope),
  span: (operation, fn) => mainLog.span(operation, fn),
}
