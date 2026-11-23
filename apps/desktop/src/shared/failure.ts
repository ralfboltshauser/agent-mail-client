import {
  type ErrorClass,
  errorClasses,
  isCorrelationId,
  type RendererLogReport,
  rendererFailureSources,
  sanitizeError,
} from '@amc/observability'

export interface FailureDetails {
  errorClass: ErrorClass
  id: string
  kind: 'Request' | 'Run'
}

export function failureDetails(
  error: unknown,
  id: string,
  kind: FailureDetails['kind'],
): FailureDetails {
  return { errorClass: sanitizeError(error).class, id, kind }
}

export function formatFailure({
  errorClass,
  id,
  kind,
}: Omit<FailureDetails, 'errorClass'> & { errorClass: string }): string {
  return `${errorClass} · ${kind} ${id}`
}

export function validFailure(value: unknown): value is FailureDetails {
  if (!value || typeof value !== 'object') return false
  const { errorClass, id, kind } = value as Partial<FailureDetails>
  return (
    typeof errorClass === 'string' &&
    (kind === 'Request' || kind === 'Run') &&
    isCorrelationId(id) &&
    errorClasses.some((known) => known === errorClass)
  )
}

export function readFailure(error: unknown): FailureDetails | undefined {
  try {
    if (!(error instanceof Error)) return
    const message = error.message.replace(/^Error invoking remote method '[a-zA-Z:]+': Error: /, '')
    if (message.length > 320) return
    const match = /^(?:[^\n]{0,256}\n)?([A-Za-z]+) · (Request|Run) ([a-f0-9-]{36})$/.exec(message)
    if (!match) return
    const details = { errorClass: match[1], kind: match[2], id: match[3] }
    return validFailure(details) ? details : undefined
  } catch {
    // An arbitrary renderer error can have a throwing message getter.
    return undefined
  }
}

export function rendererReport(value: unknown): RendererLogReport | undefined {
  if (!value || typeof value !== 'object') return
  const { source, errorClass, requestId, runId } = value as Partial<RendererLogReport>
  if (
    !source ||
    !rendererFailureSources.includes(source) ||
    (requestId !== undefined && !isCorrelationId(requestId)) ||
    (runId !== undefined && !isCorrelationId(runId)) ||
    !errorClass ||
    !errorClasses.includes(errorClass)
  )
    return
  return { source, errorClass, requestId, runId }
}
