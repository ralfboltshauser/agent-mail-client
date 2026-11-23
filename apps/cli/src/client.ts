import { fetchWithRequestId, newRequestId, type RequestId } from '@amc/observability'
import type { ApiError } from '@amc/protocol'
import type { CliConfig } from './config.ts'

type RequestOptions = {
  method?: string
  body?: unknown
  redirect?: RequestInit['redirect']
  signal?: AbortSignal
}

export class EngineError extends Error {
  readonly status: number
  readonly code: string
  readonly requestId?: RequestId

  constructor(status: number, code: string, message: string, requestId?: RequestId) {
    super(message)
    this.status = status
    this.code = code
    this.requestId = requestId
  }
}

export async function response(
  engineUrl: string,
  path: string,
  init: RequestOptions & { token?: string } = {},
): Promise<Response> {
  const url = new URL(path, engineUrl)
  const requestId = newRequestId()
  let res: Response
  try {
    res = await fetchWithRequestId(
      url,
      {
        method: init.method ?? 'GET',
        signal: init.signal,
        redirect: init.redirect ?? 'follow',
        headers: {
          ...(init.token ? { Authorization: `Bearer ${init.token}` } : {}),
          ...(init.body !== undefined ? { 'Content-Type': 'application/json' } : {}),
        },
        body: init.body !== undefined ? JSON.stringify(init.body) : undefined,
      },
      requestId,
    )
  } catch (error) {
    throw new EngineError(
      0,
      'unreachable',
      `Cannot reach the Engine at ${url.origin}: ${(error as Error).message}`,
      requestId,
    )
  }
  if (!res.ok) {
    const err = (await res.json().catch(() => ({}))) as Partial<ApiError>
    throw new EngineError(
      res.status,
      err.error ?? 'error',
      err.message ?? res.statusText,
      requestId,
    )
  }
  return res
}

export async function request<T>(
  engineUrl: string,
  path: string,
  init: RequestOptions & { token?: string } = {},
): Promise<T> {
  const res = await response(engineUrl, path, init)
  const body = await res.text()
  return (body ? JSON.parse(body) : null) as T
}

export function authed(config: CliConfig) {
  return <T>(path: string, init: RequestOptions = {}) =>
    request<T>(config.engineUrl, path, { ...init, token: config.token })
}
