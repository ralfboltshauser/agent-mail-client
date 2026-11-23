import { AsyncLocalStorage } from 'node:async_hooks'
import type { Env, MiddlewareHandler } from 'hono'
import { matchedRoutes } from 'hono/route'
import { httpMethod } from './engine-events.ts'
import {
  isCorrelationId,
  newRequestId,
  REQUEST_ID_HEADER,
  type RequestId,
  RUN_ID_HEADER,
  type RunId,
} from './ids.ts'
import type { Logger } from './index.ts'

export interface RequestLogEnv extends Env {
  Variables: { requestId: RequestId }
}

const requestScope = new AsyncLocalStorage<RequestId>()

/** For transport callbacks invoked within the HTTP request. */
export const currentRequestId = () => requestScope.getStore()

/** Register first. Route names come from Hono's registered patterns only. */
export function requestLogging<E extends RequestLogEnv>(
  log: Logger,
  routineRoutes: ReadonlySet<string> = new Set(),
): MiddlewareHandler<E> {
  return async (c, next) => {
    const incoming = c.req.header(REQUEST_ID_HEADER)
    const requestId = isCorrelationId(incoming) ? (incoming as RequestId) : newRequestId()
    const incomingRun = c.req.header(RUN_ID_HEADER)
    // Client-supplied correlation metadata never participates in authorization.
    const runId = isCorrelationId(incomingRun) ? (incomingRun as RunId) : undefined
    c.set('requestId', requestId)
    c.header(REQUEST_ID_HEADER, requestId)
    const start = performance.now()
    await requestScope.run(requestId, next)
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
      { requestId, runId },
    )
  }
}
