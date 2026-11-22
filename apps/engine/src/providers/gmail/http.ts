import { setTimeout as sleep } from 'node:timers/promises'
import { type AccessTokens, GMAIL_TIMEOUT_MS, OAuthError } from './oauth.ts'
import { QUOTA_COST, QuotaLimiter } from './ratelimit.ts'
import type {
  GmailApi,
  GmailDraft,
  GmailHistoryList,
  GmailLabel,
  GmailListMessages,
  GmailMessage,
  GmailMessageRef,
  GmailMessageState,
  GmailProfile,
} from './types.ts'

const BASE = 'https://gmail.googleapis.com/gmail/v1/users/me'

export class GmailHttpError extends Error {
  readonly status: number
  readonly reason: string
  readonly retryAfterMs: number

  constructor(status: number, reason: string, message: string, retryAfterMs = 0) {
    super(message)
    this.status = status
    this.reason = reason
    this.retryAfterMs = retryAfterMs
  }
}

export interface RetryInfo {
  path: string
  status: number
  delayMs: number
  rate: number
}

type Cost = keyof typeof QUOTA_COST

interface CallOptions {
  params?: Record<string, string | string[] | undefined>
  method?: 'GET' | 'POST' | 'PUT' | 'DELETE'
  body?: unknown
  cost?: Cost
  /** Skip ahead of backfill in the quota queue. */
  urgent?: boolean
  /** The caller handles retries for these calls. */
  writeback?: boolean
  submission?: boolean
  signal?: AbortSignal | undefined
  beforeDispatch?: (() => void) | undefined
}

/**
 * Gmail REST over fetch: token refresh on 401, an adaptive quota limiter, and backoff on
 * rate limits and server errors.
 */
export class GmailHttpApi implements GmailApi {
  readonly #tokens: AccessTokens
  readonly #fetch: typeof fetch
  readonly #limiter: QuotaLimiter
  readonly #timeoutMs: number
  readonly #onRetry: ((info: RetryInfo) => void) | undefined

  constructor(
    tokens: AccessTokens,
    fetchImpl: typeof fetch = fetch,
    options: {
      limiter?: QuotaLimiter
      onRetry?: (info: RetryInfo) => void
      timeoutMs?: number
    } = {},
  ) {
    this.#tokens = tokens
    this.#fetch = fetchImpl
    this.#limiter = options.limiter ?? new QuotaLimiter()
    this.#onRetry = options.onRetry
    this.#timeoutMs = options.timeoutMs ?? GMAIL_TIMEOUT_MS
  }

  async #call<T>(path: string, options: CallOptions = {}): Promise<T> {
    const url = new URL(BASE + path)
    for (const [key, value] of Object.entries(options.params ?? {})) {
      for (const item of Array.isArray(value) ? value : [value]) {
        if (item !== undefined) url.searchParams.append(key, item)
      }
    }

    const { signal } = options
    let refreshed = false
    for (let attempt = 0; ; attempt++) {
      signal?.throwIfAborted()
      await this.#limiter.take(
        QUOTA_COST[options.cost ?? 'get'] ?? 5,
        options.urgent ?? (options.cost !== 'get' && options.cost !== 'list'),
      )
      let res: Response
      let text: string
      try {
        signal?.throwIfAborted()
        const token = await this.#tokens.get()
        signal?.throwIfAborted()
        options.beforeDispatch?.()
        const timeout = AbortSignal.timeout(options.submission ? 60_000 : this.#timeoutMs)
        res = await this.#fetch(url, {
          method: options.method ?? 'GET',
          signal: signal ? AbortSignal.any([signal, timeout]) : timeout,
          ...(options.submission ? { redirect: 'error' } : {}),
          headers: {
            Authorization: `Bearer ${token}`,
            ...(options.body !== undefined ? { 'Content-Type': 'application/json' } : {}),
          },
          ...(options.body !== undefined ? { body: JSON.stringify(options.body) } : {}),
        })
        text = await res.text()
        signal?.throwIfAborted()
      } catch (error) {
        signal?.throwIfAborted()
        if (options.writeback || options.method || attempt >= 8 || error instanceof OAuthError)
          throw error
        await this.#delay(path, 0, attempt, signal)
        continue
      }
      if (res.ok) {
        this.#limiter.reward()
        return (text ? JSON.parse(text) : undefined) as T
      }

      let body: { error?: { message?: string; errors?: { reason?: string }[] } } = {}
      try {
        body = JSON.parse(text) ?? {}
      } catch {
        // A proxy can return an error page in place of a Gmail error object.
      }
      const reason = body.error?.errors?.[0]?.reason ?? ''
      const message = body.error?.message ?? res.statusText
      if (res.status === 401 && !refreshed) {
        refreshed = true
        this.#tokens.invalidate()
        if (!options.writeback || options.method === undefined) continue
      }

      const quota =
        res.status === 429 ||
        (res.status === 403 &&
          /rateLimitExceeded|userRateLimitExceeded|quotaExceeded|quota exceeded/i.test(
            `${reason} ${message}`,
          ))
      const retryHeader = res.headers.get('retry-after')
      const seconds = Number(retryHeader)
      const retryMs = Number.isFinite(seconds)
        ? seconds * 1000
        : Date.parse(retryHeader ?? '') - Date.now()
      const retryAfterMs = retryMs > 0 ? retryMs : 0
      const retryable =
        quota ||
        res.status === 408 ||
        res.status >= 500 ||
        (res.status === 403 && reason === 'backendError')
      if (retryable && attempt < 8 && !options.writeback && !options.submission) {
        if (quota) this.#limiter.penalize()
        await this.#delay(path, res.status, attempt, signal, quota, retryAfterMs)
        continue
      }
      if (quota) this.#limiter.penalize()
      throw new GmailHttpError(
        res.status,
        reason,
        `Gmail ${path}: ${res.status} ${message}`,
        retryAfterMs,
      )
    }
  }

  async #delay(
    path: string,
    status: number,
    attempt: number,
    signal: AbortSignal | undefined,
    quota = false,
    retryAfterMs = 0,
  ) {
    const base = quota ? Math.min(5_000 * (attempt + 1), 60_000) : 2 ** attempt * 500
    const delayMs = (retryAfterMs || base) + Math.random() * 250
    this.#onRetry?.({ path, status, delayMs, rate: this.#limiter.rate })
    await sleep(delayMs, undefined, signal ? { signal } : undefined)
  }

  async watch(topicName: string, signal: AbortSignal): Promise<number> {
    const { expiration } = await this.#call<{ expiration: string }>('/watch', {
      method: 'POST',
      body: { topicName },
      cost: 'watch',
      signal,
      writeback: true,
    })
    return Number(expiration)
  }

  profile(signal?: AbortSignal) {
    return this.#call<GmailProfile>('/profile', { cost: 'profile', signal })
  }

  async labels(signal?: AbortSignal) {
    return (
      (await this.#call<{ labels?: GmailLabel[] }>('/labels', { cost: 'labels', signal })).labels ??
      []
    )
  }

  listMessages(
    options: { pageToken?: string; q?: string; maxResults?: number },
    signal?: AbortSignal,
  ) {
    return this.#call<GmailListMessages>('/messages', {
      params: {
        pageToken: options.pageToken,
        q: options.q,
        includeSpamTrash: options.q ? undefined : 'true',
        maxResults: String(options.maxResults ?? 500),
      },
      cost: 'list',
      signal,
    })
  }

  async getMessage(id: string, urgent = false, signal?: AbortSignal) {
    try {
      return await this.#call<GmailMessage>(`/messages/${encodeURIComponent(id)}`, {
        params: { format: 'full' },
        cost: 'get',
        urgent,
        signal,
      })
    } catch (error) {
      if (error instanceof GmailHttpError && error.status === 404) return null
      throw error
    }
  }

  async history(
    startHistoryId: string,
    pageToken?: string,
    writeback = false,
    signal?: AbortSignal,
  ) {
    try {
      return await this.#call<GmailHistoryList>('/history', {
        params: {
          startHistoryId,
          pageToken,
          maxResults: '500',
          historyTypes: writeback
            ? ['messageAdded', 'labelAdded', 'labelRemoved', 'messageDeleted']
            : undefined,
        },
        writeback,
        cost: 'history',
        signal,
      })
    } catch (error) {
      // 404: the start point is too old; the caller must resync.
      if (error instanceof GmailHttpError && error.status === 404) return null
      throw error
    }
  }

  async getMessageState(id: string, writeback = false, signal?: AbortSignal) {
    try {
      return await this.#call<GmailMessageState>(`/messages/${encodeURIComponent(id)}`, {
        params: { format: 'minimal', fields: 'labelIds,historyId' },
        cost: 'get',
        urgent: true,
        writeback,
        signal,
      })
    } catch (error) {
      if (error instanceof GmailHttpError && error.status === 404) return null
      throw error
    }
  }

  async getThreadMessages(id: string): Promise<GmailMessage[]> {
    try {
      const thread = await this.#call<{ messages?: GmailMessage[] }>(
        `/threads/${encodeURIComponent(id)}`,
        {
          params: {
            format: 'full',
            fields: 'messages(id,threadId,labelIds,internalDate,historyId)',
          },
          cost: 'threadGet',
          urgent: true,
          writeback: true,
        },
      )
      return thread.messages ?? []
    } catch (error) {
      if (error instanceof GmailHttpError && error.status === 404) return []
      throw error
    }
  }

  modifyMessage(
    id: string,
    addLabelIds: string[],
    removeLabelIds: string[],
    beforeDispatch?: () => void,
  ) {
    return this.#call<GmailMessageState>(`/messages/${encodeURIComponent(id)}/modify`, {
      method: 'POST',
      params: { fields: 'labelIds,historyId' },
      body: { addLabelIds, removeLabelIds },
      cost: 'modify',
      beforeDispatch,
      urgent: true,
      writeback: true,
    })
  }

  setTrashed(id: string, trashed: boolean): Promise<GmailMessageState> {
    const action = trashed ? 'trash' : 'untrash'
    return this.#call<GmailMessageState>(`/messages/${encodeURIComponent(id)}/${action}`, {
      method: 'POST',
      params: { fields: 'labelIds,historyId' },
      cost: action,
      urgent: true,
      writeback: true,
    })
  }

  createLabel(name: string, signal?: AbortSignal): Promise<GmailLabel> {
    return this.#call('/labels', {
      method: 'POST',
      body: { name, labelListVisibility: 'labelShow', messageListVisibility: 'show' },
      cost: 'labelCreate',
      signal,
      urgent: true,
      writeback: true,
    })
  }

  async attachment(messageId: string, attachmentId: string) {
    const res = await this.#call<{ data: string }>(
      `/messages/${encodeURIComponent(messageId)}/attachments/${encodeURIComponent(attachmentId)}`,
      { cost: 'attachment' },
    )
    return Buffer.from(res.data, 'base64url')
  }

  saveDraft(input: { draftId?: string; raw: string; threadId?: string }) {
    const message = {
      raw: Buffer.from(input.raw, 'utf8').toString('base64url'),
      ...(input.threadId ? { threadId: input.threadId } : {}),
    }
    return input.draftId
      ? this.#call<GmailDraft>(`/drafts/${encodeURIComponent(input.draftId)}`, {
          method: 'PUT',
          body: { id: input.draftId, message },
          cost: 'draftUpdate',
          submission: true,
        })
      : this.#call<GmailDraft>('/drafts', {
          method: 'POST',
          body: { message },
          cost: 'draftCreate',
          submission: true,
        })
  }

  listDrafts(pageToken?: string) {
    return this.#call<{ drafts?: GmailDraft[]; nextPageToken?: string }>('/drafts', {
      params: { pageToken, maxResults: '100' },
      cost: 'draftList',
    })
  }

  async getDraft(id: string) {
    try {
      return await this.#call<GmailDraft>(`/drafts/${encodeURIComponent(id)}`, {
        params: { format: 'minimal' },
        cost: 'draftGet',
      })
    } catch (error) {
      if (error instanceof GmailHttpError && error.status === 404) return null
      throw error
    }
  }

  sendMessage(input: { raw: string; threadId?: string }) {
    return this.#call<GmailMessageRef>('/messages/send', {
      method: 'POST',
      submission: true,
      cost: 'send',
      body: {
        raw: Buffer.from(input.raw, 'utf8').toString('base64url'),
        ...(input.threadId ? { threadId: input.threadId } : {}),
      },
    })
  }

  async deleteDraft(draftId: string) {
    try {
      await this.#call<void>(`/drafts/${encodeURIComponent(draftId)}`, {
        method: 'DELETE',
        cost: 'draftDelete',
        submission: true,
        writeback: true,
      })
      return true
    } catch (error) {
      if (error instanceof GmailHttpError && error.status === 404) return false
      throw error
    }
  }
}
