import type { AccessTokens } from './oauth.ts'
import type {
  GmailApi,
  GmailHistoryList,
  GmailLabel,
  GmailListMessages,
  GmailMessage,
  GmailProfile,
} from './types.ts'

const BASE = 'https://gmail.googleapis.com/gmail/v1/users/me'

export class GmailHttpError extends Error {
  readonly status: number
  readonly reason: string

  constructor(status: number, reason: string, message: string) {
    super(message)
    this.status = status
    this.reason = reason
  }
}

const sleep = (ms: number) => new Promise((resolve) => setTimeout(resolve, ms))

/** Gmail REST over fetch, with token refresh on 401 and backoff on rate limits and 5xx. */
export class GmailHttpApi implements GmailApi {
  readonly #tokens: AccessTokens
  readonly #fetch: typeof fetch

  constructor(tokens: AccessTokens, fetchImpl: typeof fetch = fetch) {
    this.#tokens = tokens
    this.#fetch = fetchImpl
  }

  async #call<T>(path: string, params: Record<string, string | undefined> = {}): Promise<T> {
    const url = new URL(BASE + path)
    for (const [key, value] of Object.entries(params))
      if (value !== undefined) url.searchParams.set(key, value)

    let refreshed = false
    for (let attempt = 0; ; attempt++) {
      const res = await this.#fetch(url, {
        headers: { Authorization: `Bearer ${await this.#tokens.get()}` },
      })
      if (res.ok) return (await res.json()) as T

      const body = (await res.json().catch(() => ({}))) as {
        error?: { message?: string; errors?: { reason?: string }[] }
      }
      const reason = body.error?.errors?.[0]?.reason ?? ''
      const message = body.error?.message ?? res.statusText
      if (res.status === 401 && !refreshed) {
        refreshed = true
        this.#tokens.invalidate()
        continue
      }
      const retryable =
        res.status === 429 ||
        res.status >= 500 ||
        (res.status === 403 && /rateLimitExceeded|userRateLimitExceeded|backendError/.test(reason))
      if (retryable && attempt < 6) {
        const retryAfter = Number(res.headers.get('retry-after'))
        const delay =
          Number.isFinite(retryAfter) && retryAfter > 0 ? retryAfter * 1000 : 2 ** attempt * 500
        await sleep(delay + Math.random() * 250)
        continue
      }
      throw new GmailHttpError(res.status, reason, `Gmail ${path}: ${res.status} ${message}`)
    }
  }

  profile() {
    return this.#call<GmailProfile>('/profile')
  }

  async labels() {
    return (await this.#call<{ labels?: GmailLabel[] }>('/labels')).labels ?? []
  }

  listMessages(options: { pageToken?: string; q?: string; maxResults?: number }) {
    return this.#call<GmailListMessages>('/messages', {
      pageToken: options.pageToken,
      q: options.q,
      maxResults: String(options.maxResults ?? 500),
    })
  }

  async getMessage(id: string) {
    try {
      return await this.#call<GmailMessage>(`/messages/${encodeURIComponent(id)}`, {
        format: 'full',
      })
    } catch (error) {
      if (error instanceof GmailHttpError && error.status === 404) return null
      throw error
    }
  }

  async history(startHistoryId: string, pageToken?: string) {
    try {
      return await this.#call<GmailHistoryList>('/history', {
        startHistoryId,
        pageToken,
        maxResults: '500',
      })
    } catch (error) {
      // 404: the start point is too old; the caller must resync.
      if (error instanceof GmailHttpError && error.status === 404) return null
      throw error
    }
  }

  async attachment(messageId: string, attachmentId: string) {
    const res = await this.#call<{ data: string }>(
      `/messages/${encodeURIComponent(messageId)}/attachments/${encodeURIComponent(attachmentId)}`,
    )
    return Buffer.from(res.data, 'base64url')
  }
}
