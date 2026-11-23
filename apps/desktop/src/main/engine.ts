import { createHash } from 'node:crypto'
import { fetchWithRequestId, newRequestId, type RequestId } from '@amc/observability'
import type { ApiError } from '@amc/protocol'
import { failureDetails } from '../shared/failure'
import { mainLog, rememberFailure } from './observability'

const requests = new WeakMap<object, RequestId>()

export function carryRequest<T extends object>(value: T, from: object): T {
  const requestId = requests.get(from)
  if (requestId) requests.set(value, requestId)
  return value
}

export function requestFor(value: object) {
  return requests.get(value)
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

/** A thin client for the Engine's HTTP API, authenticated as this Mac. */
export class EngineClient {
  readonly baseUrl: string
  readonly pairingScope: string
  readonly #token: string

  constructor(baseUrl: string, token: string) {
    this.baseUrl = baseUrl
    this.#token = token
    this.pairingScope = createHash('sha256')
      .update(JSON.stringify(['desktop-review', baseUrl, token]))
      .digest('hex')
  }

  async get<T>(path: string, init: { signal?: AbortSignal } = {}): Promise<T> {
    return this.request<T>(path, { method: 'GET', ...init })
  }

  async request<T>(
    path: string,
    init: { method: string; body?: unknown; signal?: AbortSignal; redirect?: RequestRedirect },
  ): Promise<T> {
    const requestId = newRequestId()
    const res = await this.response(path, init, requestId)
    if (res.status === 204) return undefined as T
    try {
      const body = (await res.json()) as T
      if (body && typeof body === 'object') requests.set(body, requestId)
      return body
    } catch (error) {
      throw this.#failed('body', requestId, error)
    }
  }

  #failed<T>(stage: 'request' | 'response' | 'body' | 'stream', requestId: RequestId, err: T): T {
    mainLog.log('error', 'desktop.http.failed', { stage, err }, { requestId })
    rememberFailure(err, failureDetails(err, requestId, 'Request'))
    return err
  }

  async #fetch(path: string, init: RequestInit, requestId: RequestId): Promise<Response> {
    try {
      const headers = new Headers(init.headers)
      headers.set('Authorization', `Bearer ${this.#token}`)
      return await fetchWithRequestId(new URL(path, this.baseUrl), { ...init, headers }, requestId)
    } catch (cause) {
      const error = new EngineError(0, 'unreachable', 'Cannot reach the Engine')
      if (init.signal?.aborted && init.signal.reason?.name === 'AbortError') throw error
      this.#failed('request', requestId, cause)
      rememberFailure(error, failureDetails(error, requestId, 'Request'))
      throw error
    }
  }

  async response(
    path: string,
    init: { method: string; body?: unknown; signal?: AbortSignal; redirect?: RequestRedirect },
    requestId = newRequestId(),
  ): Promise<Response> {
    const res = await this.#fetch(
      path,
      {
        method: init.method,
        redirect: init.redirect,
        headers: init.body !== undefined ? { 'Content-Type': 'application/json' } : undefined,
        ...(init.body !== undefined ? { body: JSON.stringify(init.body) } : {}),
        ...(init.signal ? { signal: init.signal } : {}),
      },
      requestId,
    )
    if (!res.ok) {
      let body: Partial<ApiError> | null = null
      try {
        body = (await res.json()) as Partial<ApiError>
      } catch (error) {
        this.#failed('body', requestId, error)
      }
      throw this.#failed(
        'response',
        requestId,
        new EngineError(
          res.status,
          body?.error ?? 'error',
          body?.message ?? 'Engine request rejected',
        ),
      )
    }
    return res
  }

  authenticatedGet(path: string, signal: AbortSignal): Promise<Response> {
    return this.#fetch(path, { redirect: 'error', signal }, newRequestId())
  }

  async bytes(path: string): Promise<Buffer> {
    const requestId = newRequestId()
    const res = await this.#fetch(path, {}, requestId)
    if (!res.ok) {
      throw this.#failed(
        'response',
        requestId,
        new EngineError(res.status, 'error', 'Engine request rejected'),
      )
    }
    try {
      return Buffer.from(await res.arrayBuffer())
    } catch (error) {
      throw this.#failed('body', requestId, error)
    }
  }

  /** Server-Sent Events; calls `onEvent` per event until the signal aborts or the stream ends. */
  async events(
    path: string,
    onEvent: (event: string, data: string) => void,
    signal: AbortSignal,
    connected?: () => void,
  ): Promise<void> {
    const requestId = newRequestId()
    const res = await this.#fetch(
      path,
      { headers: { Accept: 'text/event-stream' }, signal },
      requestId,
    )
    if (!res.ok || !res.body) {
      throw this.#failed(
        'stream',
        requestId,
        new EngineError(res.status, 'error', 'Event stream refused'),
      )
    }
    connected?.()
    try {
      await this.#readEvents(res.body, onEvent)
    } catch (error) {
      if (signal.aborted) return
      throw this.#failed('stream', requestId, error)
    }
  }

  async #readEvents(
    body: ReadableStream<Uint8Array>,
    onEvent: (event: string, data: string) => void,
  ) {
    const decoder = new TextDecoder()
    let buffer = ''
    for await (const chunk of body as unknown as AsyncIterable<Uint8Array>) {
      buffer += decoder.decode(chunk, { stream: true })
      let split = buffer.indexOf('\n\n')
      while (split !== -1) {
        const block = buffer.slice(0, split)
        buffer = buffer.slice(split + 2)
        let event = 'message'
        const data: string[] = []
        for (const line of block.split('\n')) {
          if (line.startsWith('event:')) event = line.slice(6).trim()
          else if (line.startsWith('data:')) data.push(line.slice(5).trimStart())
        }
        onEvent(event, data.join('\n'))
        split = buffer.indexOf('\n\n')
      }
    }
  }
}
