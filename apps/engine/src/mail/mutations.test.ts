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

  it('rejects Organise for legacy Agent tokens and reserves Trash for owner Clients', async () => {
    const { db, gmail, queue, request } = await setup()
    const agent = issueToken(db, { kind: 'agent', name: 'Legacy Agent', scopes: ['organize'] })
    const limited = issueToken(db, { kind: 'cli', name: 'Limited CLI', scopes: ['organize'] })
    const owner = issueToken(db, {
      kind: 'desktop',
      name: 'Desktop',
      scopes: ['organize', 'admin'],
    })
    vi.spyOn(queue, 'kick').mockImplementation(() => {})
    const app = createApp({ db, config: testConfig(), log: silentLog, mutations: queue })
    const post = (token: string, mutations: MutationRequest[]) =>
      app.request('/v1/mutations', {
        method: 'POST',
        headers: { Authorization: `Bearer ${token}`, 'Content-Type': 'application/json' },
        body: JSON.stringify({ mutations }),
      })
    const archive = request({ kind: 'archive', threadId: THREAD })
    const trash = request({ kind: 'trash', threadId: THREAD, value: true })
    expect((await post(agent.secret, [archive])).status).toBe(403)
    expect((await post(agent.secret, [trash])).status).toBe(403)
    expect((await post(limited.secret, [archive, trash])).status).toBe(403)
    // A row accepted by the old endpoint must also be refused at dispatch.
    queue.submit(agent.id, [trash])
    await queue.tick()
    expect(queue.lookup(agent.id, [trash.id])[0]?.status).toBe('failed')
    expect(await gmail.getMessageLabels('m1')).toContain('INBOX')
    const ownerTrash = request(trash.action)
    expect((await post(owner.secret, [ownerTrash])).status).toBe(200)
    await queue.tick()
    expect(await gmail.getMessageLabels('m1')).toContain('TRASH')
  })

  it('compensates a Trash committed before its response was lost and a retry was refused', async () => {
    const { gmail, queue, store, submit, lookup, advance, now, thread } = await setup()
    gmail.trashFailure = { afterWrite: true, error: new Error('connection lost') }
    const trash = submit({ kind: 'trash', threadId: THREAD, value: true })
    await queue.tick()
    expect(lookup(trash.id)?.status).toBe('pending')
    expect(await gmail.getMessageLabels('m1')).toContain('TRASH')
    const threadMessages = gmail.getThreadMessages.bind(gmail)
    vi.spyOn(gmail, 'getThreadMessages').mockImplementation(async (id) =>
      (await threadMessages(id)).filter((message) => !message.labelIds?.includes('TRASH')),
    )
    gmail.trashFailure = {
      afterWrite: false,
      error: new GmailHttpError(403, 'forbidden', 'refused'),
    }
    advance(2000)
    await new Mutations(store, () => gmail, silentLog, now).tick()
    expect(lookup(trash.id)).toMatchObject({
      status: 'failed',
      error: 'Gmail refused the change (HTTP 403)',
    })
    expect(await gmail.getMessageLabels('m1')).toEqual(expect.arrayContaining(['INBOX', 'UNREAD']))
    expect(thread()?.labelIds).not.toContain('a:TRASH')
  })

  it('reports and reflects Trash remaining in Gmail if compensation is refused', async () => {
    const { gmail, queue, submit, lookup, thread } = await setup()
    const call = gmail.setTrashed.bind(gmail)
    vi.spyOn(gmail, 'setTrashed').mockImplementation(async (id, trashed) => {
      if (id !== 'm1' || !trashed) throw new GmailHttpError(403, 'forbidden', 'refused')
      return call(id, trashed)
    })
    const trash = submit({ kind: 'trash', threadId: THREAD, value: true })
    await queue.tick()
    expect(lookup(trash.id)?.error).toContain('Gmail may have kept part of the change')
    expect(await gmail.getMessageLabels('m1')).toContain('TRASH')
    expect(thread()?.labelIds).toContain('a:TRASH')
  })

  it('reverses only the applied part of a failed batch', async () => {
    const { gmail, queue, submit, lookup } = await setup()
    gmail.setLabels('m2', ['SENT', 'STARRED', 'Label_work'])
    gmail.add('m3', { threadId: 'thread', labels: ['INBOX'] })
    gmail.batchFailure = { applied: 1, error: new GmailHttpError(403, 'forbidden', 'refused') }
    const label = submit({ kind: 'label', threadId: THREAD, labelId: 'a:Label_work', value: true })
    await queue.tick()
    expect(lookup(label.id)?.status).toBe('failed')
    expect(await gmail.getMessageLabels('m1')).not.toContain('Label_work')
    expect(await gmail.getMessageLabels('m2')).toContain('Label_work')
    expect(await gmail.getMessageLabels('m3')).not.toContain('Label_work')
  })

  it('does not undo an archive already performed in Gmail while the replica still showed Inbox', async () => {
    const { gmail, queue, submit, lookup, thread } = await setup()
    gmail.setLabels('m1', ['UNREAD'])
    expect(thread()?.inInbox).toBe(true)
    const archive = submit({ kind: 'archive', threadId: THREAD })
    const undo = submit({ kind: 'undo', threadId: THREAD, mutationId: archive.id })
    await queue.tick()
    await queue.tick()
    expect(lookup(undo.id)?.status).toBe('applied')
    expect(await gmail.getMessageLabels('m1')).toEqual(['UNREAD'])
    expect(thread()?.inInbox).toBe(false)
  })

  it('archives a Gmail reply absent from the replica and can undo just the changed labels', async () => {
    const { gmail, queue, submit, lookup, sync, thread } = await setup()
    const archive = submit({ kind: 'archive', threadId: THREAD })
    gmail.add('m3', { threadId: 'thread', labels: ['INBOX', 'Label_work'] })
    await queue.tick()
    expect(await gmail.getMessageLabels('m3')).toEqual(['Label_work'])
    expect(thread()?.messageCount).toBe(2)
    const undo = submit({ kind: 'undo', threadId: THREAD, mutationId: archive.id })
    await queue.tick()
    expect(lookup(undo.id)?.status).toBe('applied')
    expect(await gmail.getMessageLabels('m3')).toEqual(['Label_work', 'INBOX'])
    await sync.incremental()
    expect(thread()).toMatchObject({ inInbox: true, messageCount: 3 })
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

  it('undoing Trash leaves Gmail Inbox membership that the original action never changed', async () => {
    const { gmail, queue, submit } = await setup()
    submit({ kind: 'trash', threadId: THREAD, value: true })
    await queue.tick()
    await gmail.setTrashed('m2', false)
    gmail.setLabels('m2', ['INBOX', 'SENT', 'STARRED'])
    submit({ kind: 'undo', threadId: THREAD })
    await queue.tick()
    expect(await gmail.getMessageLabels('m2')).toContain('INBOX')
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

  it('discards a reconciliation label read overtaken by live history', async () => {
    const { gmail, sync, thread, state } = await setup()
    gmail.oldestHistory = Number(state.cursor().historyId) + 1
    gmail.setLabels('m1', ['INBOX', 'UNREAD', 'Label_work'])
    await sync.incremental()
    let release!: () => void
    const held = new Promise<void>((resolve) => {
      release = resolve
    })
    let start!: () => void
    const started = new Promise<void>((resolve) => {
      start = resolve
    })
    gmail.afterLabelRead = () => {
      start()
      return held
    }
    const scanning = sync.backfillStep()
    await started
    gmail.setLabels('m1', ['UNREAD', 'Label_work'])
    await sync.incremental()
    release()
    await scanning
    while (await sync.backfillStep()) {}
    expect(await sync.incremental()).toBe(0)
    expect(thread()?.inInbox).toBe(false)
  })

  it('does not restore the Snoozed label after undoing Archive past the old deadline', async () => {
    const { gmail, queue, submit, advance, now, thread } = await setup()
    submit({ kind: 'snooze', threadId: THREAD, until: now() + 60_000 })
    await queue.tick()
    submit({ kind: 'archive', threadId: THREAD })
    await queue.tick()
    advance(60_000)
    submit({ kind: 'undo', threadId: THREAD })
    await queue.tick()
    const label = gmail.labelList.find((l) => l.name === 'AMC/Snoozed')
    expect(await gmail.getMessageLabels('m1')).not.toContain(label?.id)
    expect(thread()).toMatchObject({ inInbox: false, snoozedUntil: null })
  })

  it('cleans the Snoozed label from Trash and wakes a surviving message when Gmail deleted another', async () => {
    const { gmail, queue, submit, advance, now, thread, sync } = await setup()
    gmail.add('m3', { threadId: 'thread', date: 3000 })
    await sync.incremental()
    submit({ kind: 'snooze', threadId: THREAD, until: now() + 60_000 })
    await queue.tick()
    const label = gmail.labelList.find((l) => l.name === 'AMC/Snoozed')
    await gmail.setTrashed('m2', true)
    gmail.remove('m3')
    advance(60_000)
    await queue.tick()
    expect(await gmail.getMessageLabels('m1')).toContain('INBOX')
    expect(await gmail.getMessageLabels('m2')).toContain('TRASH')
    expect(await gmail.getMessageLabels('m2')).not.toContain(label?.id)
    expect(await gmail.getMessageLabels('m2')).not.toContain('INBOX')
    await sync.incremental()
    expect(thread()).toMatchObject({ inInbox: true, snoozedUntil: null, messageCount: 2 })
    expect(thread()?.labelIds).not.toContain('a:AMC/Snoozed')
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

  it('undo compensates for Inbox added by untrash to a previously archived message', async () => {
    const { gmail, queue, submit } = await setup()
    gmail.setLabels('m1', ['UNREAD'])
    const call = gmail.setTrashed.bind(gmail)
    vi.spyOn(gmail, 'setTrashed').mockImplementation(async (id, value) => {
      const labels = await call(id, value)
      if (value) return labels
      const restored = [...labels, 'INBOX']
      gmail.setLabels(id, restored)
      return restored
    })
    const trash = submit({ kind: 'trash', threadId: THREAD, value: true })
    await queue.tick()
    submit({ kind: 'undo', mutationId: trash.id })
    await queue.tick()
    expect(await gmail.getMessageLabels('m1')).toEqual(['UNREAD'])
  })

  it('preserves an independent archive between the Trash guard and a rejected request', async () => {
    const { gmail, queue, submit, lookup, thread } = await setup()
    const call = gmail.setTrashed.bind(gmail)
    const trash = vi.spyOn(gmail, 'setTrashed').mockImplementation(async (id, value) => {
      if (id === 'm1' && value) {
        gmail.setLabels(id, ['UNREAD'])
        throw new GmailHttpError(403, 'forbidden', 'refused')
      }
      return call(id, value)
    })
    const mutation = submit({ kind: 'trash', threadId: THREAD, value: true })
    await queue.tick()
    expect(trash.mock.calls).toEqual([['m1', true]])
    expect(await gmail.getMessageLabels('m1')).toEqual(['UNREAD'])
    expect(thread()?.inInbox).toBe(false)
    expect(lookup(mutation.id)).toMatchObject({
      status: 'failed',
      error: 'Gmail refused the change (HTTP 403)',
      superseded: ['a:m1'],
    })
  })

  it('preserves Inbox restored independently while saved compensation waits for restart', async () => {
    const { gmail, queue, store, submit, lookup, advance, now, thread } = await setup()
    gmail.setLabels('m1', ['UNREAD'])
    const original = gmail.setTrashed.bind(gmail)
    const trash = vi
      .spyOn(gmail, 'setTrashed')
      .mockImplementationOnce(original)
      .mockRejectedValueOnce(new GmailHttpError(403, 'forbidden', 'refused'))
      .mockRejectedValueOnce(new GmailHttpError(429, 'rateLimitExceeded', 'quota'))
    const mutation = submit({ kind: 'trash', threadId: THREAD, value: true })
    await queue.tick()
    expect(lookup(mutation.id)?.status).toBe('pending')
    await original('m1', false)
    gmail.setLabels('m1', ['UNREAD', 'INBOX'])
    advance(2000)
    await new Mutations(store, () => gmail, silentLog, now).tick()
    expect(trash.mock.calls).toEqual([
      ['m1', true],
      ['m2', true],
      ['m1', false],
    ])
    expect(await gmail.getMessageLabels('m1')).toEqual(['UNREAD', 'INBOX'])
    expect(thread()?.inInbox).toBe(true)
    expect(lookup(mutation.id)).toMatchObject({
      status: 'failed',
      error: 'Gmail refused the change (HTTP 403)',
      superseded: ['a:m1'],
    })
  })

  it('does not record an Inbox inverse for an archive superseded after preparation', async () => {
    const { gmail, queue, submit, lookup, thread } = await setup()
    const get = gmail.getThreadMessages.bind(gmail)
    vi.spyOn(gmail, 'getThreadMessages').mockImplementationOnce(async (id) => {
      const snapshot = await get(id)
      gmail.setLabels('m1', ['UNREAD'])
      return snapshot
    })
    const batch = vi.spyOn(gmail, 'batchModify')
    const archive = submit({ kind: 'archive', threadId: THREAD })
    await queue.tick()
    expect(lookup(archive.id)).toMatchObject({
      status: 'applied',
      error: null,
      superseded: ['a:m1'],
    })
    submit({ kind: 'undo', mutationId: archive.id })
    await queue.tick()
    expect(batch).not.toHaveBeenCalled()
    expect(thread()?.inInbox).toBe(false)
    expect(await gmail.getMessageLabels('m1')).toEqual(['UNREAD'])
  })

  it('undo skips a change made after preparation and still inverts other messages', async () => {
    const { gmail, queue, submit, lookup } = await setup()
    const label = submit({ kind: 'label', labelId: 'a:Label_work', value: true, threadId: THREAD })
    await queue.tick()
    const get = gmail.getThreadMessages.bind(gmail)
    vi.spyOn(gmail, 'getThreadMessages').mockImplementationOnce(async (id) => {
      const snapshot = await get(id)
      gmail.setLabels('m1', ['INBOX', 'UNREAD', 'STARRED'])
      return snapshot
    })
    const batch = vi.spyOn(gmail, 'batchModify')
    const undo = submit({ kind: 'undo', mutationId: label.id })
    await queue.tick()
    expect(batch.mock.calls).toEqual([[['m2'], [], ['Label_work']]])
    expect(lookup(undo.id)).toMatchObject({ status: 'applied', error: null, superseded: ['a:m1'] })
    expect(await gmail.getMessageLabels('m1')).toEqual(['INBOX', 'UNREAD', 'STARRED'])
    expect(await gmail.getMessageLabels('m2')).toEqual(['SENT', 'STARRED'])
  })

  it('leaves a reply delivered between the final read and the batch in Gmail Inbox', async () => {
    const { gmail, queue, sync, submit, lookup, thread } = await setup()
    const call = gmail.batchModify.bind(gmail)
    const batch = vi
      .spyOn(gmail, 'batchModify')
      .mockImplementationOnce(async (ids, add, remove) => {
        gmail.add('m3', { threadId: 'thread' })
        return call(ids, add, remove)
      })
    const archive = submit({ kind: 'archive', threadId: THREAD })
    await queue.tick()
    expect(lookup(archive.id)).toMatchObject({ status: 'applied', superseded: [] })
    expect(thread()).toMatchObject({ inInbox: false, messageCount: 2 })
    await sync.incremental()
    await queue.tick()
    expect(thread()).toMatchObject({ inInbox: true, messageCount: 3 })
    expect(await gmail.getMessageLabels('m1')).toEqual(['UNREAD'])
    expect(await gmail.getMessageLabels('m3')).toEqual(['INBOX', 'UNREAD'])
    expect(batch.mock.calls).toEqual([[['m1'], [], ['INBOX']]])
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
