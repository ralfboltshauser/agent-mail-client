import { describe, expect, it } from 'vitest'
import { DbAccountState } from '../../accounts.ts'
import { BlobStore } from '../../blobs.ts'
import { MailQueries } from '../../mail/queries.ts'
import { MailStore } from '../../mail/store.ts'
import { silentLog, tempDir, testDb } from '../../test-support.ts'
import { FakeGmail } from './fake.ts'
import { GmailAccountSync } from './sync.ts'

function setup(pageSize?: number) {
  const db = testDb()
  db.prepare(
    "INSERT INTO account (id, kind, address, credentials, created_at) VALUES ('a', 'gmail', 'owner@example.com', x'00', 0)",
  ).run()
  const store = new MailStore(db, new BlobStore(tempDir()))
  const gmail = new FakeGmail()
  if (pageSize) {
    const list = gmail.listMessages.bind(gmail)
    gmail.listMessages = (o) => list({ ...o, maxResults: pageSize })
  }
  const state = new DbAccountState(db, 'a', ['owner@example.com'])
  const sync = new GmailAccountSync(gmail, store, state, silentLog)
  const queries = new MailQueries(db)
  const backfillAll = async () => {
    while (await sync.backfillStep()) {}
  }
  return { db, store, gmail, state, sync, queries, backfillAll }
}

describe('Gmail sync', () => {
  it('backfills the inbox first, then everything, resumably', async () => {
    const { gmail, sync, queries, state, backfillAll } = setup(2)
    gmail.add('m1', { labels: ['INBOX'] })
    gmail.add('m2', { labels: ['SENT'] })
    gmail.add('m3', { labels: ['INBOX', 'UNREAD'] })
    await sync.start()
    expect(state.backfill().phase).toBe('recent')
    await sync.backfillStep()
    expect(queries.threads({ inbox: true }).threads.map((t) => t.id)).toEqual(['a:t-m3', 'a:t-m1'])
    await backfillAll()
    expect(state.backfill().phase).toBe('done')
    expect(queries.threads().threads).toHaveLength(3)
    // Messages already stored in the inbox pass are not fetched again in the full pass.
    expect(gmail.calls.getMessage).toBe(3)
  })

  it('applies new mail, label changes and deletions from history', async () => {
    const { gmail, sync, queries, backfillAll } = setup()
    gmail.add('m1')
    await sync.start()
    await backfillAll()

    gmail.add('m2', { threadId: 't-m1', from: 'Bob <bob@example.com>' })
    gmail.setLabels('m1', ['STARRED'])
    expect(await sync.incremental()).toBeGreaterThan(0)
    const thread = queries.thread('a:t-m1')
    expect(thread?.messageCount).toBe(2)
    expect(thread?.starred).toBe(true)
    expect(thread?.participants.map((p) => p.address)).toEqual([
      'bob@example.com',
      'alice@example.com',
    ])

    gmail.remove('m2')
    gmail.remove('m1')
    await sync.incremental()
    expect(queries.thread('a:t-m1')).toBeNull()
  })

  it('history recorded before the backfill finishes is not lost', async () => {
    const { gmail, sync, queries, backfillAll } = setup()
    gmail.add('m1')
    await sync.start()
    gmail.add('m2') // arrives mid-backfill
    await backfillAll()
    await sync.incremental()
    expect(queries.threads().threads).toHaveLength(2)
  })

  it('resyncs and reconciles when the history has expired', async () => {
    const { gmail, sync, queries, state, backfillAll } = setup()
    gmail.add('m1')
    gmail.add('m2')
    await sync.start()
    await backfillAll()

    gmail.remove('m1')
    gmail.add('m3')
    gmail.oldestHistory = Number.MAX_SAFE_INTEGER
    await sync.incremental()
    expect(state.backfill()).toMatchObject({ phase: 'all', reconcile: true })
    gmail.oldestHistory = 0
    await backfillAll()
    expect(
      queries
        .threads()
        .threads.map((t) => t.id)
        .sort(),
    ).toEqual(['a:t-m2', 'a:t-m3'])
  })

  it('refreshes labels for a Gmail message skipped when list pages shift', async () => {
    const { gmail, sync, queries, state, backfillAll } = setup(1)
    gmail.add('m1')
    gmail.add('m2')
    await sync.start()
    await backfillAll()
    gmail.oldestHistory = Number(state.cursor().historyId) + 1
    gmail.setLabels('m1', ['STARRED'])
    await sync.incremental()
    await sync.backfillStep() // The first offset page contains m2.
    gmail.remove('m2') // m1 shifts onto that page and will be omitted by the next page.
    await sync.incremental()
    await backfillAll()
    expect(await sync.incremental()).toBe(0)
    expect(queries.thread('a:t-m1')).toMatchObject({
      inInbox: false,
      labelIds: ['a:STARRED'],
    })
    expect(queries.thread('a:t-m2')).toBeNull()
  })

  it('keeps newer history labels when the final reconciliation read was already in flight', async () => {
    const { gmail, sync, queries, state, backfillAll } = setup(1)
    gmail.add('m1')
    gmail.add('m2')
    await sync.start()
    await backfillAll()

    gmail.oldestHistory = Number(state.cursor().historyId) + 1
    gmail.setLabels('m1', ['STARRED'])
    await sync.incremental()
    await sync.backfillStep()
    gmail.remove('m2')

    let read!: () => void
    let release!: () => void
    const reading = new Promise<void>((resolve) => {
      read = resolve
    })
    const held = new Promise<void>((resolve) => {
      release = resolve
    })
    gmail.afterLabelRead = async () => {
      read()
      await held
    }
    const finalPage = sync.backfillStep()
    await reading
    gmail.setLabels('m1', ['INBOX', 'UNREAD'])
    await sync.incremental()
    release()
    await finalPage

    expect(await sync.incremental()).toBe(0)
    expect(queries.thread('a:t-m1')).toMatchObject({
      inInbox: true,
      labelIds: ['a:INBOX', 'a:UNREAD'],
    })
  })

  it('records every change in the change log', async () => {
    const { db, gmail, sync, backfillAll } = setup()
    gmail.add('m1')
    await sync.start()
    await backfillAll()
    const entities = (
      db.prepare('SELECT entity FROM change_log').all() as { entity: string }[]
    ).map((r) => r.entity)
    expect(entities).toEqual(expect.arrayContaining(['label', 'message', 'thread']))
  })
})
