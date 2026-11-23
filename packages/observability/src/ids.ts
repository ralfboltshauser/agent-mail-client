export const REQUEST_ID_HEADER = 'x-amc-request-id'

declare const requestIdBrand: unique symbol
declare const runIdBrand: unique symbol
export type RequestId = string & { readonly [requestIdBrand]: true }
export type RunId = string & { readonly [runIdBrand]: true }

export function isCorrelationId(value: unknown): value is string {
  return (
    typeof value === 'string' &&
    value.length === 36 &&
    /^[0-9a-f]{8}-[0-9a-f]{4}-4[0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/.test(value)
  )
}

export function newRequestId(): RequestId {
  return globalThis.crypto.randomUUID() as RequestId
}

export function newRunId(): RunId {
  return globalThis.crypto.randomUUID() as RunId
}

/** Reserve an ID before the call when failure details need to retain it. */
export function fetchWithRequestId(
  input: RequestInfo | URL,
  init?: RequestInit,
  requestId = newRequestId(),
  fetcher: typeof fetch = globalThis.fetch,
): Promise<Response> {
  const headers = new Headers(
    init?.headers ?? (input instanceof Request ? input.headers : undefined),
  )
  headers.set(REQUEST_ID_HEADER, isCorrelationId(requestId) ? requestId : newRequestId())
  return fetcher(input, { ...init, headers })
}
