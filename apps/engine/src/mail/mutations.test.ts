import { randomUUID } from 'node:crypto'
import { rmSync } from 'node:fs'
import { join } from 'node:path'
import { type MutationRequest, type OrganiseAction, SNOOZED_LABEL } from '@amc/protocol'
import { describe, expect, it, vi } from 'vitest'
import { DbAccountState } from '../accounts.ts'
import { issueToken } from '../auth/tokens.ts'
import { BlobStore } from '../blobs.ts'
import { migrate, openDatabase } from '../db/database.ts'
import { createApp } from '../http/app.ts'
import { FakeGmail } from '../providers/gmail/fake.ts'
import { GmailHttpApi, GmailHttpError } from '../providers/gmail/http.ts'
import { AccessTokens } from '../providers/gmail/oauth.ts'
import { QuotaLimiter } from '../providers/gmail/ratelimit.ts'
import { GmailAccountSync } from '../providers/gmail/sync.ts'
import { silentLog, tempDir, testConfig, testDb } from '../test-support.ts'
import { Mutations } from './mutations.ts'
import { MailQueries } from './queries.ts'
import { MailStore } from './store.ts'

const THREAD = 'a:thread'
const REQUESTOR = 'test-device'

async function setup(blobDir = tempDir(), db = testDb()) {
  let now = 100_000
  db.prepare(
    "INSERT INTO account (id, kind, address, credentials, created_at) VALUES ('a', 'gmail', 'owner@example.com', x'00', 0)",
  ).run()
  const store = new MailStore(db, new BlobStore(blobDir), () => now)
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

  it('preserves a Trash whose response was lost when another write is refused', async () => {
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
      superseded: ['a:m1'],
    })
    expect(await gmail.getMessageLabels('m1')).toEqual(['INBOX', 'UNREAD', 'TRASH'])
    expect(thread()?.labelIds).toContain('a:TRASH')
  })

  it('continues after an individual refusal and undoes only the acknowledged messages', async () => {
    const { gmail, queue, submit, lookup, sync, thread } = await setup()
    gmail.setLabels('m2', ['INBOX', 'SENT'])
    gmail.add('m3', { threadId: 'thread', labels: ['INBOX'] })
    await sync.incremental()
    const modify = gmail.batchModify.bind(gmail)
    const write = vi.spyOn(gmail, 'batchModify').mockImplementation(async (ids, add, remove) => {
      if (ids.includes('m2')) throw new GmailHttpError(403, 'forbidden', 'refused')
      return modify(ids, add, remove)
    })
    const archive = submit({ kind: 'archive', threadId: THREAD })
    await queue.tick()
    expect(lookup(archive.id)).toMatchObject({
      status: 'partial',
      messages: expect.arrayContaining([
        {
          messageId: 'a:m1',
          status: 'applied',
          appliedLabels: ['a:INBOX'],
          supersededLabels: [],
          failedLabels: [],
        },
        {
          messageId: 'a:m2',
          status: 'failed',
          appliedLabels: [],
          supersededLabels: [],
          failedLabels: ['a:INBOX'],
        },
        {
          messageId: 'a:m3',
          status: 'applied',
          appliedLabels: ['a:INBOX'],
          supersededLabels: [],
          failedLabels: [],
        },
      ]),
    })
    expect(thread()?.messages.map((m) => [m.id, m.labelIds.includes('a:INBOX')])).toEqual([
      ['a:m1', false],
      ['a:m2', true],
      ['a:m3', false],
    ])
    write.mockClear()
    submit({ kind: 'undo', mutationId: archive.id })
    await queue.tick()
    expect(write.mock.calls).toEqual([
      [['m1'], ['INBOX'], []],
      [['m3'], ['INBOX'], []],
    ])
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

  it('keeps other Gmail edits when reconciling a permanent refusal', async () => {
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

  it.each([true, false])(
    'keeps successful Trash on partial refusal with initial Inbox=%s',
    async (inInbox) => {
      const { gmail, queue, thread, submit, lookup, store, now, advance } = await setup()
      if (!inInbox) gmail.setLabels('m1', ['UNREAD'])
      const original = gmail.setTrashed.bind(gmail)
      const trash = vi.spyOn(gmail, 'setTrashed').mockImplementation(async (id, trashed) => {
        if (id === 'm2') throw new GmailHttpError(403, 'forbidden', 'refused')
        if (!trashed) throw new Error('unexpected automatic untrash')
        return original(id, trashed)
      })
      const action = submit({ kind: 'trash', threadId: THREAD, value: true })
      await queue.tick()
      advance(2000)
      await new Mutations(store, () => gmail, silentLog, now).tick()
      expect(lookup(action.id)).toMatchObject({ status: 'partial' })
      expect(trash.mock.calls).toEqual([
        ['m1', true],
        ['m2', true],
      ])
      expect(thread()?.inInbox).toBe(false)
      expect((await gmail.getMessageLabels('m1'))?.includes('INBOX')).toBe(inInbox)
      trash.mockImplementation(original)
      submit({ kind: 'undo', mutationId: action.id })
      await queue.tick()
      expect(trash.mock.calls).toEqual([
        ['m1', true],
        ['m2', true],
        ['m1', false],
      ])
      expect(thread()?.inInbox).toBe(inInbox)
    },
  )

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
    expect(trash.mock.calls).toEqual([
      ['m1', true],
      ['m2', true],
    ])
    expect(await gmail.getMessageLabels('m1')).toEqual(['UNREAD'])
    expect(thread()?.inInbox).toBe(false)
    expect(lookup(mutation.id)).toMatchObject({
      status: 'partial',
      error: 'Gmail refused the change (HTTP 403)',
    })
  })

  it('keeps acknowledged Trash independently of a Snoozed-label conflict and refusal', async () => {
    const { gmail, queue, submit, lookup, now } = await setup()
    submit({ kind: 'snooze', threadId: THREAD, until: now() + 60000 })
    await queue.tick()
    const marker = gmail.labelList.find((label) => label.name === SNOOZED_LABEL)?.id
    const setTrashed = gmail.setTrashed.bind(gmail)
    const trash = vi.spyOn(gmail, 'setTrashed').mockImplementation(async (id, trashed) => {
      const labels = await setTrashed(id, trashed)
      if (id === 'm2' && trashed)
        gmail.setLabels(
          'm1',
          (gmail.messages.get('m1')?.labelIds ?? []).filter((label) => label !== marker),
        )
      return labels
    })
    vi.spyOn(gmail, 'batchModify').mockRejectedValueOnce(
      new GmailHttpError(403, 'forbidden', 'refused'),
    )
    const action = submit({ kind: 'trash', threadId: THREAD, value: true })
    await queue.tick()
    expect(lookup(action.id)).toMatchObject({
      status: 'partial',
      messages: [
        {
          messageId: 'a:m1',
          status: 'applied',
          appliedLabels: ['a:TRASH'],
          supersededLabels: ['a:AMC/Snoozed'],
          failedLabels: [],
        },
        {
          messageId: 'a:m2',
          status: 'failed',
          appliedLabels: ['a:TRASH'],
          supersededLabels: [],
          failedLabels: ['a:AMC/Snoozed'],
        },
      ],
    })
    expect(trash.mock.calls).toEqual([
      ['m1', true],
      ['m2', true],
    ])
    submit({ kind: 'undo', mutationId: action.id })
    await queue.tick()
    expect(trash.mock.calls).toEqual([
      ['m1', true],
      ['m2', true],
      ['m1', false],
      ['m2', false],
    ])
    expect(await gmail.getMessageLabels('m1')).not.toContain(marker)
    expect(await gmail.getMessageLabels('m2')).toContain(marker)
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

  it('archives a reply already visible in the final Gmail read', async () => {
    const { gmail, queue, submit, lookup } = await setup()
    gmail.afterThreadRead = () => {
      gmail.add('m3', { threadId: 'thread' })
    }
    const archive = submit({ kind: 'archive', threadId: THREAD })
    await queue.tick()
    expect(lookup(archive.id)).toMatchObject({ status: 'applied', superseded: [] })
    expect(await gmail.getMessageLabels('m3')).toEqual(['UNREAD'])
  })

  it('never untrashes a message independently trashed after a refused write', async () => {
    const { gmail, queue, store, submit, lookup, advance, now } = await setup()
    const write = vi
      .spyOn(gmail, 'setTrashed')
      .mockRejectedValueOnce(new GmailHttpError(429, 'rateLimitExceeded', 'quota'))
      .mockRejectedValueOnce(new GmailHttpError(403, 'forbidden', 'refused'))
    const action = submit({ kind: 'trash', value: true, threadId: THREAD })
    await queue.tick()
    gmail.setLabels('m1', ['UNREAD', 'TRASH'])
    advance(2000)
    await new Mutations(store, () => gmail, silentLog, now).tick()
    expect(write.mock.calls).toEqual([
      ['m1', true],
      ['m2', true],
    ])
    expect(lookup(action.id)).toMatchObject({ status: 'failed', superseded: ['a:m1'] })
    expect(await gmail.getMessageLabels('m1')).toEqual(['UNREAD', 'TRASH'])
  })

  it('refreshes OAuth before the next guard read and never replays a stale Trash POST', async () => {
    const { gmail, store, submit, lookup, advance, now } = await setup()
    gmail.setLabels('m1', ['UNREAD'])
    gmail.remove('m2')
    const trace: string[] = []
    const tokens = new AccessTokens(
      { clientId: 'test', clientSecret: 'test' },
      {
        refreshToken: 'test',
        scope: '',
      },
      async () => {
        trace.push('refresh')
        gmail.setLabels('m1', ['UNREAD', 'INBOX'])
        return Response.json({ access_token: 'refreshed', expires_in: 3600 })
      },
    )
    tokens.seed('expired-at-provider', Date.now() + 3600_000)
    const api = new GmailHttpApi(
      tokens,
      async (_url, options) => {
        if (options?.method === 'GET') {
          trace.push('read')
          return Response.json({ messages: await gmail.getThreadMessages('thread') })
        }
        trace.push('write')
        if (trace.filter((event) => event === 'write').length === 1)
          return Response.json({}, { status: 401 })
        return Response.json({ labelIds: await gmail.setTrashed('m1', true) })
      },
      { limiter: new QuotaLimiter({ rate: 10_000, maxRate: 10_000 }) },
    )
    const queue = new Mutations(store, () => api, silentLog, now)
    const action = submit({ kind: 'trash', value: true, threadId: THREAD })
    await queue.tick()
    expect(lookup(action.id)?.status).toBe('pending')
    advance(2000)
    await queue.tick()
    expect(trace).toEqual(['read', 'read', 'write', 'refresh', 'read', 'read'])
    expect(lookup(action.id)).toMatchObject({ status: 'applied', superseded: ['a:m1'] })
    expect(await gmail.getMessageLabels('m1')).toEqual(['UNREAD', 'INBOX'])
  })

  it.each(['remove marker', 'trash target', 'delete target'] as const)(
    'replans a wake when the owner can %s before the final read',
    async (edit) => {
      const { gmail, queue, submit, advance, now, thread } = await setup()
      submit({ kind: 'snooze', until: now() + 1000, threadId: THREAD })
      await queue.tick()
      advance(1000)
      gmail.afterThreadRead = () => {
        if (edit === 'delete target') gmail.remove('m2')
        else if (edit === 'trash target') {
          gmail.setLabels('m2', [...(gmail.messages.get('m2')?.labelIds ?? []), 'TRASH'])
        } else {
          const marker = gmail.labelList.find((label) => label.name === 'AMC/Snoozed')?.id
          for (const [id, message] of gmail.messages) {
            gmail.setLabels(
              id,
              (message.labelIds ?? []).filter((label) => label !== marker),
            )
          }
        }
      }
      await queue.tick()
      expect(thread()?.snoozedUntil).toBeNull()
      expect((await gmail.getMessageLabels('m1'))?.includes('INBOX')).toBe(edit !== 'remove marker')
      expect((await gmail.getMessageLabels('m2'))?.includes('INBOX') ?? false).toBe(false)
    },
  )

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

describe.each([
  ['lost response', () => new Error('connection lost')],
  ['503 after commit', () => new GmailHttpError(503, 'backendError', 'response failed')],
] as const)('Gmail %s', (_fault, failure) => {
  it('preserves owner Trash when explicit Undo loses its acknowledgement before SQLite reopen', async () => {
    const directory = tempDir()
    const path = join(directory, 'engine.sqlite')
    let db = openDatabase(path)
    try {
      migrate(db)
      const { gmail, queue, submit, lookup, advance, now } = await setup(directory, db)
      const original = gmail.setTrashed.bind(gmail)
      const write = vi.spyOn(gmail, 'setTrashed').mockImplementation(async (id, trashed) => {
        if (id === 'm2' && trashed) throw new GmailHttpError(403, 'forbidden', 'refused')
        const labels = await original(id, trashed)
        if (!trashed) throw failure()
        return labels
      })
      const trash = submit({ kind: 'trash', value: true, threadId: THREAD })
      await queue.tick()
      expect(lookup(trash.id)?.status).toBe('partial')
      expect(write.mock.calls).toEqual([
        ['m1', true],
        ['m2', true],
      ])

      const undo = submit({ kind: 'undo', mutationId: trash.id })
      await queue.tick()
      expect(lookup(undo.id)?.status).toBe('pending')
      expect(await gmail.getMessageLabels('m1')).toEqual(['INBOX', 'UNREAD'])
      gmail.setLabels('m1', ['INBOX', 'UNREAD', 'TRASH'])
      advance(2000)
      db.close()
      db = openDatabase(path)
      const store = new MailStore(db, new BlobStore(directory), now)
      const restarted = new Mutations(store, () => gmail, silentLog, now)
      await restarted.tick()
      expect(write.mock.calls).toEqual([
        ['m1', true],
        ['m2', true],
        ['m1', false],
      ])
      expect(restarted.lookup(REQUESTOR, [undo.id])[0]).toMatchObject({
        status: 'applied',
        messages: [{ messageId: 'a:m1', status: 'superseded', supersededLabels: ['a:TRASH'] }],
      })
      expect(await gmail.getMessageLabels('m1')).toEqual(['INBOX', 'UNREAD', 'TRASH'])
      expect(new MailQueries(db).thread(THREAD)?.inInbox).toBe(false)
    } finally {
      db.close()
      rmSync(directory, { recursive: true, force: true })
    }
  })

  it('recovers after Snoozed label creation without creating it twice', async () => {
    const { gmail, queue, store, submit, lookup, advance, now } = await setup()
    const create = gmail.createLabel.bind(gmail)
    const spy = vi.spyOn(gmail, 'createLabel').mockImplementationOnce(async (name) => {
      await create(name)
      throw failure()
    })
    const snooze = submit({ kind: 'snooze', threadId: THREAD, until: now() + 60_000 })
    await queue.tick()
    expect(lookup(snooze.id)?.status).toBe('pending')
    advance(2000)
    await new Mutations(store, () => gmail, silentLog, now).tick()
    expect(lookup(snooze.id)).toMatchObject({ status: 'applied', superseded: [] })
    expect(spy).toHaveBeenCalledTimes(1)
    const label = gmail.labelList.find(({ name }) => name === SNOOZED_LABEL)?.id
    expect(await gmail.getMessageLabels('m1')).toEqual(['UNREAD', label])
  })

  const paths = [
    { kind: 'archive' },
    { kind: 'trash', value: true },
    { kind: 'trash', value: false },
    { kind: 'read', value: true },
    { kind: 'star', value: true },
    { kind: 'label', labelId: 'a:Label_work', value: true },
    { kind: 'snooze', until: 160_000 },
    { kind: 'mute', value: true },
    { kind: 'undo' },
    { kind: 'wake' },
    { kind: 'suppress' },
    { kind: 'trash cleanup' },
  ] as const

  it.each(paths)('re-reads Gmail after an ambiguous write on $kind $value', async (path) => {
    const { gmail, queue, store, sync, submit, now, advance, db } = await setup()
    if (path.kind === 'trash' && !path.value) gmail.setLabels('m1', ['INBOX', 'UNREAD', 'TRASH'])
    if (path.kind === 'undo') {
      submit({ kind: 'archive', threadId: THREAD })
      await queue.tick()
    }
    if (path.kind === 'wake' || path.kind === 'trash cleanup') {
      submit({ kind: 'snooze', threadId: THREAD, until: now() + 1000 })
      await queue.tick()
      if (path.kind === 'wake') advance(1000)
      else submit({ kind: 'trash', threadId: THREAD, value: true })
    } else if (path.kind === 'suppress') {
      submit({ kind: 'mute', value: true, threadId: THREAD })
      await queue.tick()
      gmail.add('m3', { threadId: 'thread' })
      await sync.incremental()
    } else {
      submit({ ...path, threadId: THREAD })
    }

    let reads = 0
    let faultAt = 0
    let dispatched: string | undefined
    gmail.onRead = () => {
      reads++
    }
    const attempted: string[] = []
    gmail.beforeWrite = (write) => {
      const key = JSON.stringify(write)
      attempted.push(key)
      if (dispatched || (path.kind === 'trash cleanup' && write.kind !== 'batch')) return
      faultAt = reads
      dispatched = key
      if (write.kind === 'trash') gmail.trashFailure = { afterWrite: true, error: failure() }
      else gmail.batchFailure = { applied: write.ids.length, error: failure() }
    }
    await queue.tick()
    expect(dispatched).toBeDefined()
    expect(db.prepare("SELECT 1 FROM mutation WHERE status = 'pending'").get()).toBeDefined()
    advance(2000)
    await new Mutations(store, () => gmail, silentLog, now).tick()
    expect(reads).toBeGreaterThan(faultAt)
    expect(attempted.filter((write) => write === dispatched)).toHaveLength(1)
    expect(db.prepare("SELECT 1 FROM mutation WHERE status = 'pending'").get()).toBeUndefined()
    const labels = db.prepare('SELECT id, provider_label_ids FROM message ORDER BY id').all()
    for (const row of labels) {
      const provider = gmail.messages.get(String(row.id).slice(2))?.labelIds ?? []
      expect(JSON.parse(String(row.provider_label_ids)).sort()).toEqual(
        store.providerLabels('a', provider).sort(),
      )
    }
    db.close()
  })
})

function seededRandom(seed: number) {
  let state = seed
  return (size: number) => {
    state ^= state << 13
    state ^= state >>> 17
    state ^= state << 5
    return (state >>> 0) % size
  }
}

describe('seeded Gmail writeback interleavings', () => {
  it('preserves Gmail owner writes and converges after sync', async () => {
    const directory = tempDir()
    const failingSeed = process.env.AMC_FUZZ_SEED
    const seeds = failingSeed
      ? [Number(failingSeed)]
      : Array.from(
          { length: Number(process.env.AMC_FUZZ_COUNT ?? 512) },
          (_, i) => i + Number(process.env.AMC_FUZZ_START ?? 1),
        )
    try {
      for (const seed of seeds) {
        const {
          db,
          gmail,
          store,
          state,
          now,
          advance,
          queue: initialQueue,
          sync: initialSync,
        } = await setup(directory)
        const pick = seededRandom(seed)
        const trace: string[] = []
        let queue = initialQueue
        let sync = initialSync
        let reply = 2
        let ownerEditedAfterRead = false
        const active = () =>
          db
            .prepare(
              "SELECT id, request, prepared FROM mutation WHERE status = 'pending' ORDER BY seq LIMIT 1",
            )
            .get()
        const ownerEdit = (phase: string) => {
          const ids = [...gmail.messages.keys()]
          const id = ids[pick(ids.length)] ?? ''
          const edit = ids.length < 2 ? 8 : pick(9)
          trace.push(`owner ${phase}: ${edit} ${id}`)
          if (phase === 'after read') ownerEditedAfterRead = true
          if (edit === 8) {
            gmail.add(`m${++reply}`, { threadId: 'thread', date: now() + reply })
            return
          }
          if (edit === 7) {
            gmail.remove(id)
            return
          }
          const before = new Set(gmail.messages.get(id)?.labelIds)
          const labels = new Set(before)
          switch (edit) {
            case 0:
              labels.delete('INBOX')
              break
            case 1:
              labels.delete('TRASH')
              labels.add('INBOX')
              break
            case 2:
              labels.add('TRASH')
              break
            case 3:
              labels.delete('TRASH')
              break
            case 4:
              if (!labels.delete('STARRED')) labels.add('STARRED')
              break
            case 5:
              if (!labels.delete('Label_work')) labels.add('Label_work')
              break
            case 6: {
              const marker = gmail.labelList.find((label) => label.name === SNOOZED_LABEL)
              if (marker) labels.delete(marker.id)
              break
            }
          }
          gmail.setLabels(id, [...labels])
        }
        const restart = () => {
          trace.push('restart')
          queue = new Mutations(store, () => gmail, silentLog, now)
          sync = new GmailAccountSync(gmail, store, state, silentLog)
        }

        // Inspect Gmail's actual label transitions and writer metadata, which are
        // independent of the executor's journal and the replica's eventual state.
        const snapshots = new Map<string, { labels: readonly string[]; revision: number }>()
        const baselines = new Map<
          string,
          Map<string, { labels: readonly string[]; revision: number }>
        >()
        let reads = 0
        let lastDispatch = 0
        let inject = true
        let violation: unknown
        gmail.onRead = (snapshot) => {
          reads++
          ownerEditedAfterRead = false
          const row = active()
          const baseline = row ? (baselines.get(String(row.id)) ?? new Map()) : undefined
          for (const [id, labels] of snapshot) {
            const read = { labels, revision: Number(gmail.messages.get(id)?.historyId) }
            snapshots.set(id, read)
            if (!baseline?.has(id)) baseline?.set(id, read)
          }
          if (row && baseline) baselines.set(String(row.id), baseline)
        }
        gmail.beforeAmcLabelChange = (id, label, present) => {
          try {
            const snapshot = snapshots.get(id)
            const owner = gmail.lastWriter.get(id)?.get(label)
            expect(snapshot).toBeDefined()
            expect(snapshot?.labels.includes(label)).not.toBe(present)
            if (owner?.writer !== 'owner') return
            if (owner.revision > (snapshot?.revision ?? 0))
              throw new Error(`Overwrote owner write after dispatch read: ${id} ${label}`)
            const row = active()
            const baseline = row && baselines.get(String(row.id))?.get(id)
            if (
              baseline &&
              owner.revision > baseline.revision &&
              baseline.labels.includes(label) === present
            )
              throw new Error(`Overwrote a visible owner change: ${id} ${label}`)
          } catch (error) {
            violation ??= error
          }
        }
        gmail.beforeWrite = (write) => {
          trace.push(`dispatch ${JSON.stringify(write)}`)
          try {
            expect(reads).toBeGreaterThan(lastDispatch)
            expect(active()).toBeDefined()
            for (const id of write.ids) {
              const labels = snapshots.get(id)?.labels
              expect(labels).toBeDefined()
              if (write.kind === 'trash') {
                expect(labels?.includes('TRASH')).toBe(!write.trashed)
              } else {
                for (const label of write.add) expect(labels).not.toContain(label)
                for (const label of write.remove) expect(labels).toContain(label)
              }
            }
          } catch (error) {
            violation ??= error
          }
          lastDispatch = reads
          if (!inject) return
          // Randomize a single owner edit at the final snapshot-to-POST boundary.
          // Two same-label flips in this window need a conditional Gmail write.
          if (pick(5) === 0 && !ownerEditedAfterRead) ownerEdit('after final read')
          const status = [0, 0, 0, 0, 0, 401, 429, 403, 503, -1, -503][pick(11)] ?? 0
          if (!status) return
          trace.push(`failure ${status}`)
          const error =
            status === -1
              ? new Error('response lost')
              : new GmailHttpError(Math.abs(status), '', 'injected')
          if (write.kind === 'trash') gmail.trashFailure = { afterWrite: status < 0, error }
          else gmail.batchFailure = { applied: status < 0 ? write.ids.length : 0, error }
        }

        try {
          for (let round = 0; round < 8; round++) {
            const actions: OrganiseAction[] = [
              { kind: 'archive', threadId: THREAD },
              { kind: 'trash', value: true, threadId: THREAD },
              { kind: 'trash', value: false, threadId: THREAD },
              { kind: 'star', value: Boolean(pick(2)), threadId: THREAD },
              { kind: 'label', labelId: 'a:Label_work', value: Boolean(pick(2)), threadId: THREAD },
              { kind: 'snooze', until: now() + 1000, noReply: Boolean(pick(2)), threadId: THREAD },
              { kind: 'mute', value: Boolean(pick(2)), threadId: THREAD },
              { kind: 'undo', threadId: THREAD },
            ]
            const action = actions[pick(actions.length)] as OrganiseAction
            const request = { id: `${seed}-${round}`, action }
            if (db.prepare('SELECT 1 FROM thread WHERE id = ?').get(THREAD)) {
              trace.push(`submit ${JSON.stringify(action)}`)
              try {
                queue.submit(REQUESTOR, [request])
              } catch (error) {
                if (
                  action.kind !== 'undo' ||
                  !(error instanceof Error) ||
                  error.message !== 'There is no matching action to undo'
                )
                  throw error
              }
            }
            if (pick(2) === 0) ownerEdit('before planning')
            if (pick(2) === 0) gmail.afterThreadRead = () => ownerEdit('after read')
            if (pick(3) === 0) restart()
            await sync.incremental()
            await queue.tick()
            if (pick(2) === 0) {
              ownerEdit('during backoff')
              restart()
              advance(4000)
              await queue.tick()
            }
            advance(1100)
          }
          inject = false
          gmail.afterThreadRead = undefined
          for (let tick = 0; tick < 24; tick++) {
            advance(301_000)
            await sync.incremental()
            await queue.tick()
            if (!db.prepare("SELECT 1 FROM mutation WHERE status = 'pending'").get()) break
          }
          await sync.incremental()
          if (violation) throw violation
          expect(
            db.prepare("SELECT 1 FROM mutation WHERE status = 'pending'").get(),
          ).toBeUndefined()
          const replica = db
            .prepare('SELECT id, provider_label_ids, label_ids FROM message ORDER BY id')
            .all()
          const truth = [...gmail.messages.values()]
            .map(({ id, labelIds }) => {
              const labels = store.providerLabels('a', labelIds ?? []).sort()
              return { id: `a:${id}`, provider_label_ids: labels, label_ids: labels }
            })
            .sort((a, b) => a.id.localeCompare(b.id))
          expect(
            replica.map((row) => ({
              id: row.id,
              provider_label_ids: (JSON.parse(String(row.provider_label_ids)) as string[]).sort(),
              label_ids: (JSON.parse(String(row.label_ids)) as string[]).sort(),
            })),
          ).toEqual(truth)
        } catch (error) {
          console.error(
            `Gmail interleaving failed for seed ${seed}. Replay with AMC_FUZZ_SEED=${seed}\n${trace.join('\n')}`,
          )
          throw error
        } finally {
          db.close()
        }
      }
    } finally {
      rmSync(directory, { recursive: true, force: true })
    }
  }, 300_000)
})
