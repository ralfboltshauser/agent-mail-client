import { expect, it, vi } from 'vitest'
import { GmailHttpApi } from './http.ts'
import { AccessTokens } from './oauth.ts'

function tokens() {
  const access = new AccessTokens(
    { clientId: 'test', clientSecret: 'test' },
    { refreshToken: 'test', scope: 'test' },
  )
  access.seed('test', Date.now() + 120_000)
  return access
}

it('aborts an in-flight Gmail request without retrying it', async () => {
  const controller = new AbortController()
  const onRetry = vi.fn()
  let markStarted!: () => void
  const started = new Promise<void>((resolve) => {
    markStarted = resolve
  })
  const request: typeof fetch = vi.fn(async (_url, opts) => {
    const signal = opts?.signal
    return new Promise<Response>((_resolve, reject) => {
      signal?.addEventListener('abort', () => reject(signal.reason), { once: true })
      markStarted()
    })
  })
  const api = new GmailHttpApi(tokens(), request, { onRetry })
  const rejected = expect(api.history('1', undefined, false, controller.signal)).rejects.toThrow(
    'reauthorized',
  )
  await started
  controller.abort(new Error('reauthorized'))
  await rejected
  expect(onRetry).not.toHaveBeenCalled()
})

it('aborts a Gmail retry delay before issuing another HTTP request', async () => {
  const controller = new AbortController()
  const request = vi
    .fn<typeof fetch>()
    .mockResolvedValue(new Response('', { status: 429, headers: { 'Retry-After': '120' } }))
  const api = new GmailHttpApi(tokens(), request, {
    onRetry: () => queueMicrotask(() => controller.abort()),
  })
  await expect(api.history('1', undefined, false, controller.signal)).rejects.toMatchObject({
    name: 'AbortError',
  })
  expect(request).toHaveBeenCalledTimes(1)
})
