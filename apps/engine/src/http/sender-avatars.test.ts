import { DatabaseSync } from 'node:sqlite'
import { PNG } from 'pngjs'
import { expect, it, vi } from 'vitest'
import { issueToken } from '../auth/tokens.ts'
import { SenderAvatars } from '../mail/avatars/index.ts'
import { AvatarLookupError, AvatarNetwork } from '../mail/avatars/network.ts'
import { SqliteAvatarIndex } from '../mail/avatars/store.ts'
import { silentLog, testConfig, testDb } from '../test-support.ts'
import { createApp } from './app.ts'
import { senderAvatarRoutes } from './sender-avatars.ts'

const day = 24 * 60 * 60 * 1000
const sourcePng = PNG.sync.write(new PNG({ width: 1, height: 1, fill: true }))
const logo = Buffer.from(
  '<svg xmlns="http://www.w3.org/2000/svg" viewBox="0 0 12 12"><circle cx="6" cy="6" r="6" fill="red"/></svg>',
)

function avatarFixture() {
  const db = new DatabaseSync(':memory:')
  const index = new SqliteAvatarIndex(db)
  const dns = vi.fn(async () => ['93.184.216.34'])
  const txt = vi.fn(async () => [['v=BIMI1; l=https://brand-cdn.dev/logo.svg; a=;']])
  const fetch = vi.fn(async (url: URL) => ({
    kind: 'image' as const,
    type: url.pathname.endsWith('svg') ? 'image/svg+xml' : 'image/png',
    bytes: url.pathname.endsWith('svg') ? logo : sourcePng,
  }))
  let now = 10 * day
  const avatars = new SenderAvatars(index, silentLog, {
    network: new AvatarNetwork({ addresses: dns, requestImage: fetch, txt }),
    now: () => now,
  })
  return {
    avatars,
    index,
    dns,
    txt,
    fetch,
    advance: (ms: number) => {
      now += ms
    },
    close: () => db.close(),
  }
}

it('serves the reserved owner API, isolates Account/message keys and gates cached BIMI per message', async () => {
  const db = testDb()
  const fixture = avatarFixture()
  try {
    db.exec(`
      INSERT INTO account (id, kind, address, credentials, created_at)
        VALUES ('a', 'imap', 'owner@fixture.dev', x'00', 0), ('b', 'gmail', 'owner@other.dev', x'00', 0);
      INSERT INTO thread (id, account_id, provider_thread_id) VALUES ('a:t', 'a', 't');
    `)
    const add =
      db.prepare(`INSERT INTO message (id, account_id, thread_id, provider_id, from_json, sent_at)
      VALUES (?, 'a', 'a:t', ?, ?, 0)`)
    add.run(
      'm1',
      'm1',
      JSON.stringify({ address: 'contact@sender.dev', name: 'Synthetic Contact' }),
    )
    add.run('m2', 'm2', JSON.stringify({ address: 'other@sender.dev', name: 'Other' }))
    add.run('webmail', 'webmail', JSON.stringify({ address: 'test@sub.gmail.com', name: 'Test' }))
    let eligible = true
    const app = createApp({
      db,
      config: testConfig(),
      log: silentLog,
      smartInbox: {
        avatars: senderAvatarRoutes(
          db,
          fixture.avatars,
          (message, domain) => eligible && message.messageId === 'm1' && domain === 'sender.dev',
        ),
      },
    })
    const cli = issueToken(db, { kind: 'cli', name: 'Fixture CLI', scopes: ['admin'] })
    const desktop = issueToken(db, { kind: 'desktop', name: 'Fixture Mac', scopes: ['admin'] })
    const readOnly = issueToken(db, { kind: 'desktop', name: 'Fixture reader', scopes: ['read'] })
    const post = (messages: { accountId: string; messageId: string }[], token = cli.secret) =>
      app.request('/v1/sender-avatars/resolve', {
        method: 'POST',
        headers: { Authorization: `Bearer ${token}`, 'Content-Type': 'application/json' },
        body: JSON.stringify({ messages }),
      })
    const get = (digest: string, token?: string, etag?: string) =>
      app.request(`/v1/sender-avatars/${digest}`, {
        headers: {
          ...(token ? { Authorization: `Bearer ${token}` } : {}),
          ...(etag ? { 'If-None-Match': etag } : {}),
        },
      })

    expect((await post([], readOnly.secret)).status).toBe(403)
    expect((await post([])).status).toBe(400)
    expect(
      await (
        await post([
          { accountId: 'b', messageId: 'm1' },
          { accountId: 'a', messageId: 'webmail' },
        ])
      ).json(),
    ).toMatchObject({ rows: [{ messageId: 'webmail', source: 'initials', digest: null }] })
    expect(fixture.dns).not.toHaveBeenCalled()
    expect(fixture.txt).not.toHaveBeenCalled()
    expect(fixture.fetch).not.toHaveBeenCalled()

    expect(await (await post([{ accountId: 'a', messageId: 'm1' }])).json()).toMatchObject({
      rows: [{ initials: 'SC', source: 'initials', digest: null }],
    })
    await vi.waitFor(() => expect(fixture.index.get('sender.dev', 'bimi')?.outcome).toBe('ready'))
    const {
      rows: [brand],
    } = await (await post([{ accountId: 'a', messageId: 'm1' }])).json()
    expect(brand).toMatchObject({ source: 'bimi', digest: expect.stringMatching(/^[a-f0-9]{64}$/) })
    expect((await get(brand.digest)).status).toBe(401)
    expect((await get(brand.digest, readOnly.secret)).status).toBe(403)
    expect((await get(brand.digest, desktop.secret)).status).toBe(404)
    const image = await get(brand.digest, cli.secret)
    expect(image.status).toBe(200)
    expect(image.headers.get('Content-Type')).toBe('image/png')
    expect(image.headers.get('ETag')).toBe(`"${brand.digest}"`)
    expect(PNG.sync.read(Buffer.from(await image.arrayBuffer()))).toMatchObject({
      width: 64,
      height: 64,
    })
    expect((await get(brand.digest, cli.secret, `"${brand.digest}"`)).status).toBe(304)

    const other = [{ accountId: 'a', messageId: 'm2' }]
    expect(await (await post(other)).json()).toMatchObject({ rows: [{ source: 'initials' }] })
    await vi.waitFor(() =>
      expect(fixture.index.get('sender.dev', 'favicon')?.outcome).toBe('ready'),
    )
    expect(await (await post(other)).json()).toMatchObject({ rows: [{ source: 'favicon' }] })
    expect(fixture.txt).toHaveBeenCalledTimes(1)
    expect(fixture.fetch.mock.calls.map(([url]) => url.hostname)).toEqual([
      'brand-cdn.dev',
      'sender.dev',
    ])

    eligible = false
    expect((await get(brand.digest, cli.secret, `"${brand.digest}"`)).status).toBe(404)
    expect(await (await post([{ accountId: 'a', messageId: 'm1' }])).json()).toMatchObject({
      rows: [{ initials: 'SC', source: 'favicon' }],
    })
  } finally {
    fixture.close()
    db.close()
  }
})

it('deduplicates domain work, falls through from unavailable BIMI and applies TTLs and stale grace', async () => {
  const fixture = avatarFixture()
  try {
    fixture.txt.mockResolvedValue([])
    for (let i = 0; i < 20; i++)
      expect(fixture.avatars.resolve(`sender${i}@sender.dev`, true)).toBeNull()
    await vi.waitFor(() =>
      expect(fixture.index.get('sender.dev', 'favicon')?.outcome).toBe('ready'),
    )
    expect(fixture.txt).toHaveBeenCalledTimes(1)
    expect(fixture.fetch).toHaveBeenCalledTimes(1)
    const asset = fixture.avatars.resolve('sender@sender.dev', true)
    expect(asset?.source).toBe('favicon')

    fixture.advance(7 * day - 1)
    for (let i = 0; i < 10; i++)
      expect(fixture.avatars.resolve('sender@sender.dev', false)).toEqual(asset)
    expect(fixture.fetch).toHaveBeenCalledTimes(1)
    fixture.advance(1)
    fixture.fetch.mockRejectedValueOnce(new AvatarLookupError('transient'))
    expect(fixture.avatars.resolve('sender@sender.dev', false)).toEqual(asset)
    await vi.waitFor(() =>
      expect(fixture.index.get('sender.dev', 'favicon')?.outcome).toBe('transient'),
    )
    expect(fixture.avatars.resolve('sender@sender.dev', false)).toEqual(asset)
    fixture.advance(15 * 60_000 - 1)
    expect(fixture.avatars.resolve('sender@sender.dev', false)).toEqual(asset)
    expect(fixture.fetch).toHaveBeenCalledTimes(2)

    fixture.advance(1)
    fixture.fetch.mockRejectedValueOnce(new AvatarLookupError('unsafe'))
    fixture.avatars.resolve('sender@sender.dev', false)
    await vi.waitFor(() =>
      expect(fixture.index.get('sender.dev', 'favicon')?.outcome).toBe('unsafe'),
    )
    expect(fixture.avatars.image(asset?.digest ?? '')).toBeNull()
    expect(fixture.avatars.resolve('sender@sender.dev', false)).toBeNull()
    fixture.advance(day - 1)
    expect(fixture.avatars.resolve('sender@sender.dev', false)).toBeNull()
    expect(fixture.fetch).toHaveBeenCalledTimes(3)
    fixture.advance(1)
    fixture.avatars.resolve('sender@sender.dev', false)
    await vi.waitFor(() =>
      expect(fixture.index.get('sender.dev', 'favicon')?.outcome).toBe('ready'),
    )
    expect(fixture.fetch).toHaveBeenCalledTimes(4)
  } finally {
    fixture.close()
  }
})

it('runs at most four domain lookups at a time', async () => {
  const db = new DatabaseSync(':memory:')
  const shutdown = new AbortController()
  const releases: ((addresses: string[]) => void)[] = []
  const addresses = vi.fn(() => new Promise<string[]>((resolve) => releases.push(resolve)))
  const requestImage = vi.fn(async () => {
    throw new AvatarLookupError('miss')
  })
  const avatars = new SenderAvatars(new SqliteAvatarIndex(db), silentLog, {
    network: new AvatarNetwork({ addresses, requestImage, txt: vi.fn() }),
    shutdown: shutdown.signal,
  })
  try {
    for (let i = 0; i < 10; i++) avatars.resolve(`fixture@sender-${i}.dev`, false)
    expect(addresses).toHaveBeenCalledTimes(4)
    releases[0]?.(['93.184.216.34'])
    await vi.waitFor(() => expect(addresses).toHaveBeenCalledTimes(5))
    expect(requestImage).toHaveBeenCalledTimes(1)
  } finally {
    shutdown.abort()
    db.close()
  }
})
