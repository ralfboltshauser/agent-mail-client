import type { SyncChanges, SyncSnapshotPage } from '@amc/protocol'
import { describe, expect, it } from 'vitest'
import { issueToken } from '../auth/tokens.ts'
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
  const app = createApp({
    db,
    config: testConfig(),
    log: silentLog,
    // Only the parts the sync routes use; the rest is unused here.
    mail: { db, store, queries, drafts } as never,
  })
  const token = issueToken(db, { kind: 'desktop', name: 'mac', scopes: ['read'] }).secret
  const get = async <T>(path: string) => {
    const res = await app.request(path, { headers: { Authorization: `Bearer ${token}` } })
    return { status: res.status, body: (await res.json()) as T }
  }
  const add = (id: string, date: number) =>
    store.putMessage('a', ['me@x.com'], fromGmail(gmail.add(id, { date })))
  return { db, store, get, add }
}

describe('sync protocol', () => {
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
    const { get, add, store } = setup()
    add('m1', 1000)
    const state = await get<{ modseq: number }>('/v1/sync/state')
    add('m2', 2000)
    store.setMessageLabels('a', 'm2', ['STARRED'])
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

  it('pages changes and asks stale clients to resync', async () => {
    const { db, get, add } = setup()
    for (let i = 1; i <= 4; i++) add(`m${i}`, i)
    const page = await get<SyncChanges>('/v1/sync/changes?since=0&limit=3')
    expect(page.body.more).toBe(true)
    db.prepare('DELETE FROM change_log WHERE modseq < 6').run()
    expect((await get('/v1/sync/changes?since=2')).status).toBe(410)
  })
})
