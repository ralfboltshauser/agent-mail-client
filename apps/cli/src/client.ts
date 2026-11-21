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

  constructor(status: number, code: string, message: string) {
    super(message)
    this.status = status
    this.code = code
  }
}

export async function request<T>(
  engineUrl: string,
  path: string,
  init: RequestOptions & { token?: string } = {},
): Promise<T> {
  const url = new URL(path, engineUrl)
  let res: Response
  try {
    res = await fetch(url, {
      method: init.method ?? 'GET',
      signal: init.signal,
      redirect: init.redirect ?? 'follow',
      headers: {
        ...(init.token ? { Authorization: `Bearer ${init.token}` } : {}),
        ...(init.body !== undefined ? { 'Content-Type': 'application/json' } : {}),
      },
      body: init.body !== undefined ? JSON.stringify(init.body) : undefined,
    })
  } catch (error) {
    throw new EngineError(
      0,
      'unreachable',
      `Cannot reach the Engine at ${url.origin}: ${(error as Error).message}`,
    )
  }
  const text = await res.text()
  const data = text ? JSON.parse(text) : null
  if (!res.ok) {
    const err = (data ?? {}) as Partial<ApiError>
    throw new EngineError(res.status, err.error ?? 'error', err.message ?? res.statusText)
  }
  return data as T
}

export function authed(config: CliConfig) {
  return <T>(path: string, init: RequestOptions = {}) =>
    request<T>(config.engineUrl, path, { ...init, token: config.token })
}
