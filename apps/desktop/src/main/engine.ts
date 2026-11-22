import { createHash } from 'node:crypto'
import type { ApiError } from '@amc/protocol'

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
    let res: Response
    try {
      res = await fetch(new URL(path, this.baseUrl), {
        method: init.method,
        redirect: init.redirect,
        headers: {
          Authorization: `Bearer ${this.#token}`,
          ...(init.body !== undefined ? { 'Content-Type': 'application/json' } : {}),
        },
        ...(init.body !== undefined ? { body: JSON.stringify(init.body) } : {}),
        ...(init.signal ? { signal: init.signal } : {}),
      })
    } catch (error) {
      throw new EngineError(
        0,
        'unreachable',
        `Cannot reach the Engine: ${(error as Error).message}`,
      )
    }
    if (!res.ok) {
      const body = (await res.json().catch(() => ({}))) as Partial<ApiError>
      throw new EngineError(res.status, body.error ?? 'error', body.message ?? res.statusText)
    }
    return (await res.json()) as T
  }

  authenticatedGet(path: string, signal: AbortSignal): Promise<Response> {
    return fetch(new URL(path, this.baseUrl), {
      headers: { Authorization: `Bearer ${this.#token}` },
      redirect: 'error',
      signal,
    })
  }

  async bytes(path: string): Promise<Buffer> {
    const res = await fetch(new URL(path, this.baseUrl), {
      headers: { Authorization: `Bearer ${this.#token}` },
    })
    if (!res.ok) throw new EngineError(res.status, 'error', res.statusText)
    return Buffer.from(await res.arrayBuffer())
  }

  /** Server-Sent Events; calls `onEvent` per event until the signal aborts or the stream ends. */
  async events(
    path: string,
    onEvent: (event: string, data: string) => void,
    signal: AbortSignal,
  ): Promise<void> {
    const res = await fetch(new URL(path, this.baseUrl), {
      headers: { Authorization: `Bearer ${this.#token}`, Accept: 'text/event-stream' },
      signal,
    })
    if (!res.ok || !res.body) throw new EngineError(res.status, 'error', 'Event stream refused')
    const decoder = new TextDecoder()
    let buffer = ''
    for await (const chunk of res.body as unknown as AsyncIterable<Uint8Array>) {
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
