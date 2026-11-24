import { randomUUID } from 'node:crypto'
import type { BucketCatalog, BucketInput, SyncChanges, SyncSnapshotPage } from '@amc/protocol'
import { describe, expect, it, vi } from 'vitest'
import { DAY_MS, issueToken, revokeToken } from '../auth/tokens.ts'
import { BlobStore } from '../blobs.ts'
import { Drafts } from '../mail/drafts.ts'
import { MailQueries } from '../mail/queries.ts'
import { MailStore } from '../mail/store.ts'
import { FakeGmail } from '../providers/gmail/fake.ts'
import { fromGmail } from '../providers/gmail/mapping.ts'
import { silentLog, tempDir, testConfig, testDb } from '../test-support.ts'
import { createApp } from './app.ts'

function setup() {
  const db = testDb()
  db.prepare(
    "INSERT INTO account (id, kind, address, credentials, created_at) VALUES ('a', 'gmail', 'me@x.com', x'00', 0)",
  ).run()
  const store = new MailStore(db, new BlobStore(tempDir()))
  const gmail = new FakeGmail()
  const queries = new MailQueries(db)
  const drafts = new Drafts(db, store, () => gmail)
  const checkMail = vi.fn(async () => true)
  const app = createApp({
    db,
    config: testConfig(),
    log: silentLog,
    // Only the parts the sync routes use; the rest is unused here.
    mail: { db, store, queries, drafts, sync: { checkMail } } as never,
  })
  const token = issueToken(db, { kind: 'desktop', name: 'mac', scopes: ['read'] }).secret
  const get = async <T>(path: string) => {
    const res = await app.request(path, { headers: { Authorization: `Bearer ${token}` } })
    return { status: res.status, body: (await res.json()) as T }
  }
  const add = (id: string, date: number) =>
    store.putMessage('a', ['me@x.com'], fromGmail(gmail.add(id, { date })))
  return { app, db, store, get, add, gmail, checkMail }
}

describe('sync protocol', () => {
  it('syncs owner Bucket settings, protects old assignments, and keeps legacy cursors moving', async () => {
    const { app, db, add, get } = setup()
    add('custom', 1_000)
    const owner = issueToken(db, {
      kind: 'cli',
      name: 'Fixture owner',
      scopes: ['admin', 'organize', 'read'],
    })
    const agent = issueToken(db, {
      kind: 'agent',
      name: 'Fixture agent',
      scopes: ['read', 'organize'],
      expiresAt: Date.now() + DAY_MS,
    })
    const call = async (path: string, method = 'GET', body?: unknown, token = owner.secret) => {
      const response = await app.request(path, {
        method,
        headers: { Authorization: `Bearer ${token}`, 'Content-Type': 'application/json' },
        body: body === undefined ? undefined : JSON.stringify(body),
      })
      return { status: response.status, body: await response.json() }
    }
    const available = await call('/v1/buckets')
    expect(available.body).toMatchObject({ revision: 0 })
    expect((await call('/v1/buckets', 'GET', undefined, agent.secret)).status).toBe(403)
    const since = (await get<{ modseq: number }>('/v1/sync/state')).body.modseq
    const create = { name: 'Receipts', requestId: randomUUID() }
    const created = await call('/v1/buckets', 'POST', create)
    expect(created.status).toBe(201)
    const {
      definition: { id },
      catalog,
    } = created.body as { definition: { id: string }; catalog: BucketCatalog }
    expect((await call('/v1/buckets', 'POST', create)).body).toEqual(created.body)
    expect(
      (await call('/v1/buckets', 'POST', { ...create, requestId: randomUUID(), name: 'receipts' }))
        .status,
    ).toBe(409)

    const legacy = await get<SyncChanges>(`/v1/sync/changes?since=${since}&limit=1`)
    expect(legacy.body).toMatchObject({ changes: [], modseq: since + 1, more: false })
    expect(legacy.body.bucketCatalog).toBeUndefined()
    expect(
      (await call(`/v1/sync/changes?since=${since}&bucketRevision=0`)).body.bucketCatalog,
    ).toEqual(catalog)
    expect(
      (
        await call(
          `/v1/sync/changes?since=${since}&bucketRevision=0`,
          'GET',
          undefined,
          agent.secret,
        )
      ).body.bucketCatalog,
    ).toBeUndefined()

    const write = { threadId: 'a:t-custom', reason: 'Fixture receipt' }
    expect((await call('/v1/bucket', 'PUT', { ...write, bucketId: id })).status).toBe(200)
    const projection = await get<SyncSnapshotPage<'thread'>>('/v1/sync/snapshot?entity=thread')
    expect(projection.body.rows[0]).toMatchObject({
      bucket: null,
      bucketAssignment: { bucketId: id },
    })
    expect((await call('/v1/bucket', 'PUT', { ...write, bucket: null })).status).toBe(409)
    expect(
      (await call('/v1/bucket', 'PUT', { ...write, bucket: 'Reply' }, agent.secret)).status,
    ).toBe(409)
    expect(
      (await call(`/v1/buckets/${id}`, 'PATCH', { name: 'Purchases', expectedRevision: 0 })).status,
    ).toBe(409)
    expect(
      (await call(`/v1/buckets/${id}`, 'PATCH', { name: 'Purchases', expectedRevision: 1 })).status,
    ).toBe(200)
    expect(
      (await call(`/v1/buckets/${id}`, 'PATCH', { archived: true, expectedRevision: 2 })).status,
    ).toBe(200)
    expect((await call('/v1/bucket', 'PUT', { ...write, bucketId: id })).status).toBe(409)
    expect(db.prepare("SELECT bucket FROM thread WHERE id = 'a:t-custom'").get()?.bucket).toBe(id)
    expect((await call('/v1/bucket', 'PUT', { ...write, bucketId: null })).status).toBe(200)
  })

  it('accepts an all-account mail check only from a paired owner with admin scope', async () => {
    const { app, db, checkMail } = setup()
    const post = (secret?: string) =>
      app.request('/v1/sync/check-mail', {
        method: 'POST',
        headers: secret ? { Authorization: `Bearer ${secret}` } : undefined,
      })
    const reader = issueToken(db, { kind: 'desktop', name: 'read-only', scopes: ['read'] })
    const agent = issueToken(db, {
      kind: 'agent',
      name: 'agent',
      scopes: ['read'],
      expiresAt: Date.now() + DAY_MS,
    })
    const owner = issueToken(db, { kind: 'desktop', name: 'owner', scopes: ['admin'] })
    expect((await post()).status).toBe(401)
    expect((await post(reader.secret)).status).toBe(403)
    expect((await post(agent.secret)).status).toBe(403)
    expect(checkMail).not.toHaveBeenCalled()
    const response = await post(owner.secret)
    expect(response.status).toBe(200)
    expect(await response.json()).toEqual({ ok: true })
    expect(checkMail).toHaveBeenCalledTimes(1)
  })

  it('snapshots Threads newest first with keyset paging', async () => {
    const { get, add } = setup()
    for (let i = 1; i <= 5; i++) add(`m${i}`, i * 1000)
    const first = await get<SyncSnapshotPage<'thread'>>('/v1/sync/snapshot?entity=thread&limit=2')
    expect(first.body.rows.map((r) => r.id)).toEqual(['a:t-m5', 'a:t-m4'])
    const second = await get<SyncSnapshotPage<'thread'>>(
      `/v1/sync/snapshot?entity=thread&limit=2&cursor=${first.body.cursor}`,
    )
    expect(second.body.rows.map((r) => r.id)).toEqual(['a:t-m3', 'a:t-m2'])
  })

  it('returns collapsed changes since a modseq, deletes included', async () => {
    const { get, add, store, gmail } = setup()
    add('m1', 1000)
    const state = await get<{ modseq: number }>('/v1/sync/state')
    add('m2', 2000)
    gmail.setLabels('m2', ['STARRED'])
    const message = await gmail.getMessageState('m2')
    store.setMessageLabels('a', 'm2', message?.labelIds ?? [], message?.historyId)
    store.deleteMessage('a', 'm1')
    const res = await get<SyncChanges>(`/v1/sync/changes?since=${state.body.modseq}`)
    const byKey = Object.fromEntries(res.body.changes.map((c) => [`${c.entity}:${c.id}`, c]))
    expect(byKey['message:a:m2']).toMatchObject({ op: 'upsert', data: { starred: true } })
    expect(byKey['thread:a:t-m1']).toMatchObject({ op: 'delete' })
    expect(byKey['message:a:m1']).toMatchObject({ op: 'delete' })
    // One entry per entity even though m2 changed twice.
    expect(res.body.changes.filter((c) => c.id === 'a:m2')).toHaveLength(1)
    expect(res.body.more).toBe(false)
  })

  it.each(['idle expiry', 'revocation before an event'])(
    'closes Agent event streams on %s',
    async (end) => {
      const { app, db, store, add } = setup()
      vi.useFakeTimers()
      try {
        const token = issueToken(db, {
          kind: 'agent',
          name: 'test',
          scopes: ['read'],
          expiresAt: Date.now() + 800,
        })
        const response = await app.request('/v1/sync/events', {
          headers: { Authorization: `Bearer ${token.secret}` },
        })
        const reader = response.body?.getReader()
        if (!reader) throw new Error('Missing event stream')
        try {
          const hello = await reader.read()
          expect(new TextDecoder().decode(hello.value)).toContain('event: hello')
          expect(store.listenerCount('change')).toBe(1)
          if (end === 'revocation before an event') {
            add('m1', 1000)
            revokeToken(db, token.id)
            await vi.advanceTimersByTimeAsync(150)
          } else {
            await vi.advanceTimersByTimeAsync(1000)
          }
          expect(store.listenerCount('change')).toBe(0)
          expect(await reader.read()).toMatchObject({ done: true })
        } finally {
          await reader.cancel()
        }
      } finally {
        vi.useRealTimers()
      }
    },
  )

  it('sets and clears a Bucket through HTTP and syncs it as Thread metadata', async () => {
    const { app, db, get, add, gmail } = setup()
    const owner = issueToken(db, { kind: 'desktop', name: 'mac', scopes: ['organize'] }).secret
    const expiresAt = Date.now() + DAY_MS
    const reader = issueToken(db, {
      kind: 'agent',
      name: 'reader',
      scopes: ['read'],
      expiresAt,
    }).secret
    db.exec(
      "INSERT INTO account (id, kind, address, credentials, created_at) VALUES ('b', 'gmail', 'other@x.com', x'00', 0)",
    )
    const scoped = issueToken(db, {
      kind: 'agent',
      name: 'scoped',
      scopes: ['organize'],
      accountId: 'b',
      expiresAt,
    }).secret
    const set = (token: string, body: BucketInput) =>
      app.request('/v1/bucket', {
        method: 'PUT',
        headers: { Authorization: `Bearer ${token}`, 'Content-Type': 'application/json' },
        body: JSON.stringify(body),
      })
    add('m1', 1000)
    const { body: before } = await get<{ modseq: number }>('/v1/sync/state')
    const input = { threadId: 'a:t-m1', bucket: 'Reply', reason: 'Needs an answer' } as const
    const original = await gmail.getMessageState('m1')
    expect((await set(reader, input)).status).toBe(403)
    expect((await set(scoped, input)).status).toBe(404)
    expect((await set(owner, { ...input, threadId: 'missing' })).status).toBe(404)
    expect((await set(owner, input)).status).toBe(200)

    const snapshot = await get<SyncSnapshotPage<'thread'>>('/v1/sync/snapshot?entity=thread')
    const assignment = {
      bucket: 'Reply',
      reason: input.reason,
      setBy: 'owner',
      setAt: expect.any(Number),
    }
    expect(snapshot.body.rows[0]?.bucket).toEqual(assignment)
    const { body: changes } = await get<SyncChanges>(`/v1/sync/changes?since=${before.modseq}`)
    expect(changes.changes).toMatchObject([
      { entity: 'thread', op: 'upsert', data: { bucket: assignment } },
    ])

    expect((await set(owner, { ...input, bucket: null })).status).toBe(200)
    const cleared = await get<SyncChanges>(`/v1/sync/changes?since=${changes.modseq}`)
    expect(cleared.body.changes).toMatchObject([
      { entity: 'thread', op: 'upsert', data: { bucket: null } },
    ])
    expect(await gmail.getMessageState('m1')).toEqual(original)
  })

  it('pages changes and asks stale clients to resync', async () => {
    const { db, get, add } = setup()
    for (let i = 1; i <= 4; i++) add(`m${i}`, i)
    const page = await get<SyncChanges>('/v1/sync/changes?since=0&limit=3')
    expect(page.body.more).toBe(true)
    db.prepare('DELETE FROM change_log WHERE modseq < 6').run()
    expect((await get('/v1/sync/changes?since=2')).status).toBe(410)
  })
})
