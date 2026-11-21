import { afterEach, expect, it, vi } from 'vitest'
import { gmailPubSub } from './pubsub.ts'

vi.mock('node:fs', () => ({
  readFileSync: () => JSON.stringify({ client_email: 'test@example.com', private_key: 'test' }),
}))

vi.mock('google-auth-library', () => ({
  JWT: class {
    async getAccessToken() {
      return { token: 'test' }
    }
  },
}))

afterEach(() => vi.unstubAllGlobals())

it.each(['', '{}'])('accepts an empty successful pull response (%j)', async (body) => {
  vi.stubGlobal('fetch', vi.fn().mockResolvedValue(new Response(body)))
  const pubSub = gmailPubSub('test', '/test')
  await expect(pubSub.pull(new AbortController().signal)).resolves.toEqual([])
})

it('rejects malformed nonempty pull responses', async () => {
  vi.stubGlobal('fetch', vi.fn().mockResolvedValue(new Response('invalid JSON')))
  const pubSub = gmailPubSub('test', '/test')
  await expect(pubSub.pull(new AbortController().signal)).rejects.toThrow(SyntaxError)
})
