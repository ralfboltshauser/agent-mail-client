import type { Env, MiddlewareHandler } from 'hono'
import { matchedRoutes } from 'hono/route'
import { httpMethod } from './engine-events.ts'
import { isCorrelationId, newRequestId, REQUEST_ID_HEADER, type RequestId } from './ids.ts'
import type { Logger } from './index.ts'

export interface RequestLogEnv extends Env {
  Variables: { requestId: RequestId }
}

/** Register first. Route names come from Hono's registered patterns only. */
export function requestLogging<E extends RequestLogEnv>(
  log: Logger,
  routineRoutes: ReadonlySet<string> = new Set(),
): MiddlewareHandler<E> {
  return async (c, next) => {
    const incoming = c.req.header(REQUEST_ID_HEADER)
    const requestId = isCorrelationId(incoming) ? (incoming as RequestId) : newRequestId()
    c.set('requestId', requestId)
    c.header(REQUEST_ID_HEADER, requestId)
    const start = performance.now()
    await next()
    c.header(REQUEST_ID_HEADER, requestId)
    const route =
      matchedRoutes(c).findLast(({ path, method }) => method !== 'ALL' || !path.endsWith('*'))
        ?.path ?? 'unmatched'
    const { status } = c.res
    const successLevel = routineRoutes.has(route) ? 'debug' : 'info'
    log.log(
      status >= 500 ? 'error' : status >= 400 ? 'warn' : successLevel,
      'http.request',
      {
        method: httpMethod(c.req.method),
        route,
        status,
        durationMs: performance.now() - start,
        ...(c.error ? { err: c.error } : {}),
      },
      { requestId },
    )
  }
}
