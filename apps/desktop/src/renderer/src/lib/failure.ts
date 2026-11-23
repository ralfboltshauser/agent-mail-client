import { newRequestId, type RendererLogReport } from '@amc/observability'
import { failureDetails, formatFailure, readFailure } from '../../../shared/failure'

export function reportRendererFailure(source: RendererLogReport['source'], error: unknown) {
  const known = readFailure(error)
  const details = known ?? failureDetails(error, newRequestId(), 'Request')
  const { id, kind, errorClass } = details
  globalThis.window?.amc?.reportFailure?.({
    source,
    errorClass,
    ...(kind === 'Run'
      ? { runId: id as RendererLogReport['runId'] }
      : { requestId: id as RendererLogReport['requestId'] }),
  })
  return details
}

export function failureText(error: unknown): string {
  const details = readFailure(error) ?? reportRendererFailure('renderer.caught', error)
  return formatFailure(details)
}

export function installRendererReporting() {
  window.addEventListener('error', (event) => {
    if (event instanceof ErrorEvent) {
      event.preventDefault()
      reportRendererFailure('window.error', event.error)
    }
  })
  window.addEventListener('unhandledrejection', (event) => {
    event.preventDefault()
    reportRendererFailure('window.unhandledrejection', event.reason)
  })
}

export function recordCaughtFailure(error: unknown) {
  if (!readFailure(error)) reportRendererFailure('renderer.caught', error)
}
