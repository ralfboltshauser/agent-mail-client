import { randomUUID } from 'node:crypto'
import type { MutationRequest, OrganiseAction } from '@amc/protocol'
import { describe, expect, it, vi } from 'vitest'
import { DbAccountState } from '../accounts.ts'
import { issueToken } from '../auth/tokens.ts'
import { BlobStore } from '../blobs.ts'
import { createApp } from '../http/app.ts'
import { FakeGmail } from '../providers/gmail/fake.ts'
import { GmailHttpError } from '../providers/gmail/http.ts'
import { GmailAccountSync } from '../providers/gmail/sync.ts'
import { silentLog, tempDir, testConfig, testDb } from '../test-support.ts'
import { Mutations } from './mutations.ts'
import { MailQueries } from './queries.ts'
import { MailStore } from './store.ts'

const THREAD = 'a:thread'
const REQUESTOR = 'test-device'

async function setup() {
  let now = 100_000
  const db = testDb()
  db.prepare(
    "INSERT INTO account (id, kind, address, credentials, created_at) VALUES ('a', 'gmail', 'owner@example.com', x'00', 0)",
  ).run()
  const store = new MailStore(db, new BlobStore(tempDir()), () => now)
  const gmail = new FakeGmail()
  gmail.labelList.push({ id: 'Label_work', name: 'Work', type: 'user' })
  gmail.add('m1', { threadId: 'thread', labels: ['INBOX', 'UNREAD'] })
  gmail.add('m2', { threadId: 'thread', labels: ['SENT', 'STARRED'] })
  const state = new DbAccountState(db, 'a', ['owner@example.com'])
  const sync = new GmailAccountSync(gmail, store, state, silentLog)
  await sync.start()
  while (await sync.backfillStep()) {}
  const queries = new MailQueries(db)
  const queue = new Mutations(
    store,
    () => gmail,
    silentLog,
    () => now,
  )
  const request = (action: OrganiseAction): MutationRequest => ({ id: randomUUID(), action })
  return {
    db,
    store,
    gmail,
    sync,
    state,
    queue,
    request,
    now: () => now,
    advance: (ms: number) => {
      now += ms
    },
    thread: () => queries.thread(THREAD),
    submit: (action: OrganiseAction) => {
      const value = request(action)
      const result = queue.submit(REQUESTOR, [value])[0]
      if (!result) throw new Error('Missing mutation')
      return result
    },
    lookup: (id: string) => queue.lookup(REQUESTOR, [id])[0],
  }
}

describe('Gmail Organise writeback', () => {
  it('applies a batch atomically and idempotently under the organize scope', async () => {
    const { db, queue, request, thread } = await setup()
    const reader = issueToken(db, { kind: 'agent', name: 'Reader', scopes: ['read'] })
    const writer = issueToken(db, { kind: 'cli', name: 'CLI', scopes: ['organize'] })
    vi.spyOn(queue, 'kick').mockImplementation(() => {})
    const app = createApp({ db, config: testConfig(), log: silentLog, mutations: queue })
    const post = (token: string, mutations: MutationRequest[]) =>
      app.request('/v1/mutations', {
        method: 'POST',
        headers: { Authorization: `Bearer ${token}`, 'Content-Type': 'application/json' },
        body: JSON.stringify({ mutations }),
      })
    const archive = request({ kind: 'archive', threadId: THREAD })
    const read = request({ kind: 'read', value: true, threadId: THREAD })
    expect((await post(reader.secret, [archive])).status).toBe(403)
    const invalid = request({
      kind: 'label',
      threadId: THREAD,
      labelId: 'other:label',
      value: true,
    })
    expect((await post(writer.secret, [archive, invalid])).status).toBe(409)
    expect(thread()).toMatchObject({ inInbox: true, unreadCount: 1 })
    const applied = await post(writer.secret, [archive, read])
    expect(applied.status).toBe(200)
    expect(thread()).toMatchObject({ inInbox: false, unreadCount: 0 })
    expect(await (await post(writer.secret, [archive, read])).json()).toEqual(await applied.json())
    expect(
      (await post(writer.secret, [{ ...read, action: { kind: 'archive', threadId: THREAD } }]))
        .status,
    ).toBe(409)
  })

  it('projects changes immediately, writes both messages, and restores per-message state on undo', async () => {
    const { gmail, queue, thread, submit, lookup, db } = await setup()
    const before = thread()?.messages.map((m) => m.labelIds)
    const archive = submit({ kind: 'archive', threadId: THREAD })
    expect(thread()?.inInbox).toBe(false)
    expect(await gmail.getMessageLabels('m1')).toContain('INBOX')
    expect(
      db.prepare('SELECT entity FROM change_log WHERE modseq = ?').get(archive.modseq),
    ).toEqual({ entity: 'thread' })
    await queue.tick()
    expect(await gmail.getMessageLabels('m1')).not.toContain('INBOX')
    const star = submit({ kind: 'star', value: true, threadId: THREAD })
    const undo = submit({ kind: 'undo', threadId: THREAD, mutationId: star.id })
    expect(thread()?.messages.map((m) => m.starred)).toEqual([false, true])
    await queue.tick()
    await queue.tick()
    expect(lookup(undo.id)?.status).toBe('applied')
    expect(await gmail.getMessageLabels('m1')).not.toContain('STARRED')
    expect(await gmail.getMessageLabels('m2')).toContain('STARRED')
    submit({ kind: 'undo', threadId: THREAD })
    await queue.tick()
    expect(thread()?.messages.map((m) => [...m.labelIds].sort())).toEqual(
      before?.map((labels) => [...labels].sort()),
    )
  })

  it('keeps other Gmail edits when reverting a permanent refusal', async () => {
    const { gmail, queue, sync, thread, submit, lookup } = await setup()
    const archive = submit({ kind: 'archive', threadId: THREAD })
    gmail.setLabels('m1', ['INBOX', 'UNREAD', 'Label_work'])
    await sync.incremental()
    expect(thread()).toMatchObject({ inInbox: false })
    expect(thread()?.labelIds).toContain('a:Label_work')
    vi.spyOn(gmail, 'batchModify').mockRejectedValueOnce(
      new GmailHttpError(403, 'forbidden', 'private provider details'),
    )
    await queue.tick()
    expect(thread()).toMatchObject({ inInbox: true })
    expect(thread()?.labelIds).toContain('a:Label_work')
    expect(lookup(archive.id)).toMatchObject({
      status: 'failed',
      error: 'Gmail refused the change (HTTP 403)',
    })
  })

  it('backs off transient failures and resumes the durable queue after restart', async () => {
    const { gmail, queue, store, submit, lookup, advance, now } = await setup()
    const api = vi
      .spyOn(gmail, 'batchModify')
      .mockRejectedValueOnce(new GmailHttpError(429, 'rateLimitExceeded', 'quota'))
    const label = submit({ kind: 'label', labelId: 'a:Label_work', value: true, threadId: THREAD })
    await queue.tick()
    expect(lookup(label.id)?.status).toBe('pending')
    const restarted = new Mutations(store, () => gmail, silentLog, now)
    await restarted.tick()
    expect(api).toHaveBeenCalledTimes(1)
    advance(2000)
    await restarted.tick()
    expect((await gmail.getMessageLabels('m1'))?.includes('Label_work')).toBe(true)
    expect((await gmail.getMessageLabels('m2'))?.includes('Label_work')).toBe(true)
    expect(lookup(label.id)?.status).toBe('applied')
  })

  it('uses trash and untrash endpoints and compensates after partial refusal', async () => {
    const { gmail, queue, thread, submit, lookup } = await setup()
    const original = gmail.setTrashed.bind(gmail)
    const trash = vi
      .spyOn(gmail, 'setTrashed')
      .mockImplementationOnce(original)
      .mockRejectedValueOnce(new GmailHttpError(403, 'forbidden', 'refused'))
    const failed = submit({ kind: 'trash', threadId: THREAD, value: true })
    expect(thread()?.labelIds).toContain('a:TRASH')
    await queue.tick()
    expect(lookup(failed.id)?.status).toBe('failed')
    expect(trash).toHaveBeenCalledWith('m1', false)
    expect(thread()?.inInbox).toBe(true)
    expect(await gmail.getMessageLabels('m1')).toContain('INBOX')
    const done = submit({ kind: 'trash', threadId: THREAD, value: true })
    await queue.tick()
    expect(lookup(done.id)?.status).toBe('applied')
    expect(await gmail.getMessageLabels('m2')).toContain('TRASH')
    submit({ kind: 'undo', threadId: THREAD })
    await queue.tick()
    expect(thread()?.inInbox).toBe(true)
    expect(await gmail.getMessageLabels('m1')).toContain('INBOX')
    expect(await gmail.getMessageLabels('m2')).not.toContain('INBOX')
  })

  it('keeps a queued archive above older history echoes and fences a read racing writeback', async () => {
    const { gmail, queue, thread, sync, state, submit } = await setup()
    gmail.setLabels('m1', ['INBOX', 'UNREAD', 'Label_work'])
    submit({ kind: 'archive', threadId: THREAD })
    await sync.incremental()
    expect(thread()?.inInbox).toBe(false)
    gmail.setLabels('m1', ['INBOX', 'Label_work'])
    const cursor = state.cursor().historyId
    let started!: () => void
    let release!: () => void
    const startedReading = new Promise<void>((resolve) => {
      started = resolve
    })
    const wait = new Promise<void>((resolve) => {
      release = resolve
    })
    const get = gmail.getMessageLabels.bind(gmail)
    vi.spyOn(gmail, 'getMessageLabels').mockImplementationOnce(async (id) => {
      const stale = await get(id)
      started()
      await wait
      return stale
    })
    const reading = sync.incremental()
    await startedReading
    await queue.tick()
    release()
    await reading
    expect(state.cursor().historyId).toBe(cursor)
    await sync.incremental()
    expect(thread()).toMatchObject({ inInbox: false, unreadCount: 0 })
    expect(thread()?.labelIds).toContain('a:Label_work')
  })

  it('stores Snooze in the Engine, mirrors its Label and returns the Thread to Inbox', async () => {
    const { gmail, queue, sync, thread, submit, advance, now } = await setup()
    submit({ kind: 'snooze', threadId: THREAD, until: now() + 60_000 })
    expect(thread()).toMatchObject({ inInbox: false, snoozedUntil: now() + 60_000 })
    await queue.tick()
    const label = gmail.labelList.find((l) => l.name === 'AMC/Snoozed')
    expect(label).toBeDefined()
    expect(await gmail.getMessageLabels('m1')).toContain(label?.id)
    await sync.incremental()
    expect(thread()?.labelIds).toContain('a:AMC/Snoozed')
    advance(60_000)
    await queue.tick()
    expect(thread()).toMatchObject({ inInbox: true, snoozedUntil: null })
    expect(await gmail.getMessageLabels('m1')).not.toContain(label?.id)
    expect(await gmail.getMessageLabels('m2')).toContain('INBOX')
  })

  it('resumes compensating a partially applied Trash after a transient refusal and restart', async () => {
    const { gmail, queue, store, thread, submit, lookup, advance, now } = await setup()
    const original = gmail.setTrashed.bind(gmail)
    const calls = vi
      .spyOn(gmail, 'setTrashed')
      .mockImplementationOnce(original)
      .mockRejectedValueOnce(new GmailHttpError(403, 'forbidden', 'refused'))
      .mockRejectedValueOnce(new GmailHttpError(429, 'rateLimitExceeded', 'quota', 3000))
    const trash = submit({ kind: 'trash', threadId: THREAD, value: true })
    await queue.tick()
    expect(calls.mock.calls).toEqual([
      ['m1', true],
      ['m2', true],
      ['m1', false],
    ])
    expect(lookup(trash.id)?.status).toBe('pending')
    const restarted = new Mutations(store, () => gmail, silentLog, now)
    advance(2000)
    await restarted.tick()
    expect(calls).toHaveBeenCalledTimes(3)
    advance(1000)
    await restarted.tick()
    expect(calls.mock.calls[3]).toEqual(['m1', false])
    expect(lookup(trash.id)?.status).toBe('failed')
    expect(thread()?.inInbox).toBe(true)
    expect(await gmail.getMessageLabels('m1')).toContain('INBOX')
  })

  it('ends a no-reply Snooze when an incoming reply arrives', async () => {
    const { gmail, queue, sync, thread, submit, advance, now } = await setup()
    submit({ kind: 'snooze', threadId: THREAD, until: now() + 60_000, noReply: true })
    await queue.tick()
    advance(1000)
    gmail.add('m3', { threadId: 'thread', date: now() })
    await sync.incremental()
    await queue.tick()
    expect(thread()).toMatchObject({ inInbox: true, snoozedUntil: null })
  })

  it('keeps replies out of Inbox locally and writes the suppression back to Gmail', async () => {
    const { gmail, queue, sync, thread, submit } = await setup()
    submit({ kind: 'mute', threadId: THREAD, value: true })
    await queue.tick()
    gmail.add('m3', { threadId: 'thread' })
    await sync.incremental()
    expect(thread()).toMatchObject({ muted: true, inInbox: false, messageCount: 3 })
    await queue.tick()
    expect(await gmail.getMessageLabels('m3')).not.toContain('INBOX')
    submit({ kind: 'undo', threadId: THREAD })
    await queue.tick()
    expect(thread()).toMatchObject({ muted: false, inInbox: true })
  })
})
