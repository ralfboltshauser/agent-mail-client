import { createHash } from 'node:crypto'
import { afterEach, expect, it, vi } from 'vitest'
import { EngineClient } from './engine'
import { resolveSenderAvatars } from './sender-avatars'

const png = Buffer.from(
  'iVBORw0KGgoAAAANSUhEUgAAAEAAAABACAYAAACqaXHeAAAAJ0lEQVR4Ae3BAQ0AAADCIPunfg43YAAAAAAAAAAAAAAAAAAAAMC9AEBAAAG3vv1rAAAAAElFTkSuQmCC',
  'base64',
)
const digest = createHash('sha256').update(png).digest('hex')
const ref = { accountId: 'fixture', messageId: 'm1' }
const input = { messages: [ref, { ...ref, messageId: 'm2' }] }
const rows = input.messages.map((message) => ({
  ...message,
  initials: 'SC',
  color: '#304879',
  source: 'favicon',
  digest,
}))
const response = (bytes: Buffer, type = 'image/png') =>
  new Response(Uint8Array.from(bytes), { headers: { 'Content-Type': type } })

afterEach(() => vi.unstubAllGlobals())

it('fetches a digest once through the authenticated paired Engine and returns only local PNG data', async () => {
  const fetch = vi
    .fn<typeof globalThis.fetch>()
    .mockResolvedValueOnce(Response.json({ rows }))
    .mockResolvedValueOnce(response(png))
    .mockResolvedValueOnce(Response.json({ rows }))
  vi.stubGlobal('fetch', fetch)
  const engine = new EngineClient('https://engine.fixture.dev', 'fixture-token')
  const result = await resolveSenderAvatars(engine, input, [])
  for (const row of result.rows)
    expect(row.image).toBe(`data:image/png;base64,${png.toString('base64')}`)
  expect(fetch.mock.calls.map(([url, init]) => [String(url), init?.redirect])).toEqual([
    ['https://engine.fixture.dev/v1/sender-avatars/resolve', 'error'],
    [`https://engine.fixture.dev/v1/sender-avatars/${digest}`, 'error'],
  ])
  expect(new Headers(fetch.mock.calls[1]?.[1]?.headers).get('Authorization')).toBe(
    'Bearer fixture-token',
  )
  expect((await resolveSenderAvatars(engine, input, [digest])).rows[0]).not.toHaveProperty('image')
  expect(fetch).toHaveBeenCalledTimes(3)
})

it.each([
  ['wrong media type', () => response(png, 'image/svg+xml')],
  ['oversized stream', () => response(Buffer.alloc(32 * 1024 + 1))],
  ['wrong digest', () => response(Buffer.concat([png, Buffer.from('different')]))],
  ['Engine denial', () => new Response(null, { status: 404 })],
])('returns a fallback on %s', async (_case, image) => {
  const fetch = vi
    .fn<typeof globalThis.fetch>()
    .mockResolvedValueOnce(Response.json({ rows }))
    .mockResolvedValueOnce(image())
  vi.stubGlobal('fetch', fetch)
  const engine = new EngineClient('https://engine.fixture.dev', 'fixture-token')
  expect((await resolveSenderAvatars(engine, input, [])).rows[0]?.image).toBeNull()
})
