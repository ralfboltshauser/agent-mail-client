import { randomUUID } from 'node:crypto'
import { rmSync } from 'node:fs'
import { join } from 'node:path'
import { type MutationRequest, type OrganiseAction, SNOOZED_LABEL } from '@amc/protocol'
import { describe, expect, it, vi } from 'vitest'
import { DbAccountState } from '../accounts.ts'
import { authenticate, DAY_MS, issueToken, revokeToken } from '../auth/tokens.ts'
import { BlobStore } from '../blobs.ts'
import { Config } from '../config.ts'
import { migrate, openDatabase } from '../db/database.ts'
import { createApp } from '../http/app.ts'
import { FakeGmail } from '../providers/gmail/fake.ts'
import { GmailHttpApi, GmailHttpError } from '../providers/gmail/http.ts'
import { AccessTokens } from '../providers/gmail/oauth.ts'
import { QUOTA_COST, QuotaLimiter } from '../providers/gmail/ratelimit.ts'
import { GmailAccountSync } from '../providers/gmail/sync.ts'
import { silentLog, tempDir, testConfig, testDb } from '../test-support.ts'
import { agentAction, organizeAsAgent } from './agent-actions.ts'
import { Mutations } from './mutations.ts'
import { MailQueries } from './queries.ts'
import { MailStore } from './store.ts'

const THREAD = 'a:thread'
const REQUESTOR = 'test-device'

async function setup(blobDir = tempDir(), db = testDb(), snoozeEnabled = true) {
  let now = 100_000
  db.prepare(
    "INSERT INTO account (id, kind, address, credentials, created_at) VALUES ('a', 'gmail', 'owner@example.com', x'00', 0)",
  ).run()
  const store = new MailStore(db, new BlobStore(blobDir), { now: () => now })
  const gmail = new FakeGmail()
  gmail.labelList.push({ id: 'Label_work', name: 'Work', type: 'user' })
  gmail.add('m1', { threadId: 'thread', labels: ['INBOX', 'UNREAD'] })
  gmail.add('m2', { threadId: 'thread', labels: ['SENT', 'STARRED'] })
  const state = new DbAccountState(db, 'a', ['owner@example.com'])
  const sync = new GmailAccountSync(gmail, store, state, silentLog)
  await sync.start()
  while (await sync.backfillStep()) {}
  const queries = new MailQueries(db, snoozeEnabled)
  const queue = new Mutations(store, () => gmail, silentLog, { now: () => now, snoozeEnabled })
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

describe('Snooze disabled', () => {
  it('defaults to on and rejects Snooze and Unsnooze when explicitly off', async () => {
    const { features: _features, ...settings } = testConfig({
      listen: { host: '127.0.0.1', port: 4410 },
    })
    const config = Config.parse(settings)
    expect(config.features.snooze).toBe(true)
    expect(Config.parse({ ...settings, features: {} }).features.snooze).toBe(true)
    await withFixture(
      async ({ db, queue, now }) => {
        const writer = issueToken(db, { kind: 'cli', name: 'CLI', scopes: ['organize'] })
        const app = createApp({
          db,
          config: { ...config, features: { snooze: false } },
          log: silentLog,
          mutations: queue,
        })
        const headers = {
          Authorization: `Bearer ${writer.secret}`,
          'Content-Type': 'application/json',
        }
        const me = await app.request('/v1/me', { headers })
        expect(await me.json()).toMatchObject({ features: { snooze: false } })
        for (const action of [
          { kind: 'snooze', threadId: THREAD, until: now() + 1000 },
          { kind: 'unsnooze', threadId: THREAD },
        ]) {
          const response = await app.request('/v1/mutations', {
            method: 'POST',
            headers,
            body: JSON.stringify({ mutations: [{ id: randomUUID(), action }] }),
          })
          expect(response.status).toBe(409)
          expect(await response.json()).toMatchObject({
            message: 'Snooze is disabled on this Engine',
          })
        }
        expect(db.prepare('SELECT 1 FROM mutation').get()).toBeUndefined()
      },
      undefined,
      false,
    )
  })

  it('does not suppress new deliveries or wake an existing Snooze', async () => {
    await withFixture(async ({ db, gmail, store, queue, submit, now, advance, sync }) => {
      const until = now() + 1000
      submit({ kind: 'snooze', threadId: THREAD, until })
      await queue.tick()
      const stopped = new Mutations(store, () => gmail, silentLog, { now })
      const writes = vi.spyOn(gmail, 'batchModify')
      gmail.add('m3', { threadId: 'thread', date: now() + 1 })
      await sync.incremental()
      await stopped.tick()
      advance(2000)
      await stopped.tick()
      expect(writes).not.toHaveBeenCalled()
      expect(await gmail.getMessageLabels('m3')).toContain('INBOX')
      expect(
        db.prepare("SELECT 1 FROM mutation WHERE json_extract(request, '$.snooze') = 1").get(),
      ).toBeUndefined()
    })
  })

  it('refuses an Undo of Snooze and discards its pending wake without writing to Gmail', async () => {
    await withFixture(async ({ gmail, store, queue, submit, lookup, request, now, advance }) => {
      const snooze = submit({ kind: 'snooze', threadId: THREAD, until: now() + 1000 })
      await queue.tick()
      advance(2000)
      gmail.batchFailure = { applied: 0, error: new GmailHttpError(429, '', 'retry later') }
      await queue.tick()
      expect(lookup(snooze.id)?.status).toBe('applied')
      const disabled = new Mutations(store, () => gmail, silentLog, { now })
      const writes = vi.spyOn(gmail, 'modifyMessage')
      expect(() =>
        disabled.submit(REQUESTOR, [request({ kind: 'undo', mutationId: snooze.id })]),
      ).toThrow('Snooze is disabled on this Engine')
      const star = request({ kind: 'star', threadId: THREAD, value: true })
      disabled.submit(REQUESTOR, [star])
      await disabled.tick()
      expect(disabled.lookup(REQUESTOR, [star.id])[0]?.status).toBe('applied')
      expect(writes.mock.calls).toEqual([['m1', ['STARRED'], []]])
      expect(
        store.db
          .prepare(
            "SELECT status, error FROM mutation WHERE json_extract(request, '$.work') = 'wake'",
          )
          .get(),
      ).toMatchObject({ status: 'failed', error: 'Snooze is disabled on this Engine' })
    })
  })

  it('never creates the Gmail marker during startup or label refresh', async () => {
    await withFixture(
      async ({ db, gmail, sync }) => {
        const createLabel = vi.spyOn(gmail, 'createLabel')
        await sync.syncLabels()
        expect(createLabel).not.toHaveBeenCalled()
        expect(gmail.labelList.some(({ name }) => name === SNOOZED_LABEL)).toBe(false)
        expect(db.prepare('SELECT 1 FROM label WHERE name = ?').get(SNOOZED_LABEL)).toBeUndefined()
      },
      undefined,
      false,
    )
  })
})

describe('Gmail Organise writeback', () => {
  it('applies a batch atomically and idempotently under the organize scope', async () => {
    const { db, queue, request, thread } = await setup()
    const reader = issueToken(db, {
      kind: 'agent',
      expiresAt: Date.now() + DAY_MS,
      name: 'Reader',
      scopes: ['read'],
    })
    const writer = issueToken(db, { kind: 'cli', name: 'CLI', scopes: ['organize'] })
    vi.spyOn(queue, 'kick').mockImplementation(() => {})
    const app = createApp({
      db,
      config: testConfig({ features: { snooze: true } }),
      log: silentLog,
      mutations: queue,
    })
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

  it('rejects Agent access to the owner Organise endpoint and reserves Trash for owner Clients', async () => {
    const { db, gmail, queue, request } = await setup()
    const agent = issueToken(db, {
      kind: 'agent',
      expiresAt: Date.now() + DAY_MS,
      name: 'Legacy Agent',
      scopes: ['organize'],
    })
    const limited = issueToken(db, { kind: 'cli', name: 'Limited CLI', scopes: ['organize'] })
    const owner = issueToken(db, {
      kind: 'desktop',
      name: 'Desktop',
      scopes: ['organize', 'admin'],
    })
    vi.spyOn(queue, 'kick').mockImplementation(() => {})
    const app = createApp({
      db,
      config: testConfig({ features: { snooze: true } }),
      log: silentLog,
      mutations: queue,
    })
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
    await new Mutations(store, () => gmail, silentLog, { now, snoozeEnabled: true }).tick()
    expect(lookup(trash.id)).toMatchObject({
      status: 'failed',
      error: 'A change to Trash may have been applied. Gmail refused the change (HTTP 403)',
      superseded: [],
      messages: [
        { messageId: 'a:m1', status: 'uncertain', uncertainLabels: ['a:TRASH'] },
        { messageId: 'a:m2', status: 'failed', failedLabels: ['a:TRASH'] },
      ],
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

  it.each(['none', 'expired history', 'after archive'] as const)(
    'undoes Archive without a Gmail acknowledgement history ID with %s',
    async (scenario) => {
      const { gmail, queue, submit, lookup, sync, thread } = await setup()
      gmail.setLabels('m2', ['INBOX', 'SENT'])
      await sync.incremental()
      if (scenario === 'expired history') {
        const before = gmail.messages.get('m1')?.historyId
        if (!before) throw new Error('Missing pre-write Gmail history ID')
        gmail.oldestHistory = Number((await gmail.profile()).historyId)
        expect(await gmail.history(before)).toBeNull()
      }
      const modify = gmail.modifyMessage.bind(gmail)
      vi.spyOn(gmail, 'modifyMessage').mockImplementation(async (...args) => {
        const { labelIds } = await modify(...args)
        return { labelIds }
      })

      const history = vi.spyOn(gmail, 'history')
      const archive = submit({ kind: 'archive', threadId: THREAD })
      await queue.tick()
      expect(history).not.toHaveBeenCalled()
      expect(lookup(archive.id)).toMatchObject({ status: 'applied', superseded: [] })
      expect(await gmail.getMessageLabels('m1')).toEqual(['UNREAD'])
      if (scenario === 'expired history') gmail.setLabels('m1', ['UNREAD', 'STARRED'])
      const ownerChanged = scenario === 'after archive'
      if (ownerChanged) {
        gmail.setLabels('m2', ['INBOX', 'SENT'])
        gmail.setLabels('m2', ['SENT'])
      }
      await sync.incremental()

      const undo = submit({ kind: 'undo', mutationId: archive.id })
      await queue.tick()
      await sync.incremental()
      expect(lookup(undo.id)).toMatchObject({
        status: 'applied',
        superseded: ownerChanged ? ['a:m2'] : [],
      })
      expect(await gmail.getMessageLabels('m1')).toContain('INBOX')
      if (scenario === 'expired history')
        expect(await gmail.getMessageLabels('m1')).toContain('STARRED')
      expect((await gmail.getMessageLabels('m2'))?.includes('INBOX')).toBe(!ownerChanged)
      expect(thread()?.inInbox).toBe(true)
    },
  )

  it('skips a deleted Thread when choosing the global Undo target', async () => {
    await withFixture(async ({ gmail, queue, submit, lookup, sync, db }) => {
      gmail.add('newer', { threadId: 'newer', labels: ['INBOX'] })
      await sync.incremental()

      submit({ kind: 'archive', threadId: THREAD })
      await queue.tick()
      const newer = submit({ kind: 'archive', threadId: 'a:newer' })
      await queue.tick()
      gmail.remove('newer')
      await sync.incremental()
      expect(db.prepare("SELECT 1 FROM thread WHERE id = 'a:newer'").get()).toBeUndefined()
      expect(lookup(newer.id)?.status).toBe('applied')

      const undo = submit({ kind: 'undo' })
      await queue.tick()
      expect(lookup(undo.id)?.status).toBe('applied')
      expect(await gmail.getMessageLabels('m1')).toContain('INBOX')
    })
  })

  it('removes and restores an existing AMC/Snoozed user Label without setting Snooze', async () => {
    await withFixture(async ({ gmail, queue, submit, lookup, sync, thread }) => {
      const providerId = 'Label_existing'
      const labelId = 'a:Label_existing'
      gmail.labelList.push({ name: SNOOZED_LABEL, id: providerId, type: 'user' })
      gmail.setLabels('m1', ['INBOX', 'UNREAD', providerId])
      await sync.syncLabels()
      await sync.incremental()
      expect(thread()?.labelIds).toContain(labelId)

      const remove = submit({ kind: 'label', threadId: THREAD, labelId, value: false })
      await queue.tick()
      expect(lookup(remove.id)?.status).toBe('applied')
      expect(await gmail.getMessageLabels('m1')).not.toContain(providerId)

      const undo = submit({ kind: 'undo', mutationId: remove.id })
      await queue.tick()
      expect(lookup(undo.id)?.status).toBe('applied')
      expect(await gmail.getMessageLabels('m1')).toContain(providerId)
      expect(await gmail.getMessageLabels('m2')).not.toContain(providerId)
      expect(thread()?.snoozedUntil).toBeNull()
    })
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

  it('refuses Gmail Mute Undo after another owner sets a newer Mute', async () => {
    const { gmail, queue, submit, request, thread, db } = await setup()
    try {
      const first = submit({ kind: 'mute', value: true, threadId: THREAD })
      await queue.tick()
      queue.submit('other-owner', [request({ kind: 'mute', value: true, threadId: THREAD })])
      await queue.tick()
      expect(() => submit({ kind: 'undo', mutationId: first.id })).toThrow(
        'Mute has changed since this action',
      )
      expect(thread()?.muted).toBe(true)
      expect(await gmail.getMessageLabels('m1')).not.toContain('INBOX')
    } finally {
      db.close()
    }
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
    const restarted = new Mutations(store, () => gmail, silentLog, { now, snoozeEnabled: true })
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
      await new Mutations(store, () => gmail, silentLog, { now, snoozeEnabled: true }).tick()
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
    const get = gmail.getMessageState.bind(gmail)
    vi.spyOn(gmail, 'getMessageState').mockImplementationOnce(async (id) => {
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

  it('archives and wakes once without writing or provisioning a Gmail marker', async () => {
    await withFixture(async ({ gmail, queue, sync, thread, submit, advance, now }) => {
      const marker = 'Label_existing'
      gmail.labelList.push({ name: SNOOZED_LABEL, id: marker, type: 'user' })
      gmail.setLabels('m1', ['INBOX', 'UNREAD', marker])
      const create = vi.spyOn(gmail, 'createLabel')
      const writes = vi.spyOn(gmail, 'modifyMessage')
      await sync.syncLabels()
      await sync.incremental()
      const until = now() + 1000
      submit({ kind: 'snooze', threadId: THREAD, until })
      await queue.tick()
      expect(thread()).toMatchObject({ inInbox: false, snoozedUntil: until })
      expect(await gmail.getMessageLabels('m1')).toEqual(['UNREAD', marker])
      advance(1000)
      await queue.tick()
      await queue.tick()
      expect(thread()).toMatchObject({ inInbox: true, snoozedUntil: null })
      expect(writes.mock.calls).toEqual([
        ['m1', [], ['INBOX']],
        ['m2', ['INBOX'], []],
      ])
      expect(create).not.toHaveBeenCalled()
      expect(await gmail.getMessageLabels('m1')).toContain(marker)
      expect(gmail.labelList).toContainEqual({ name: SNOOZED_LABEL, id: marker, type: 'user' })
    })
  })

  it.each([false, true])(
    'wakes a self-sent thread after Archive, Undo and sync unless the owner handled it (%s)',
    async (ownerHandled) => {
      await withFixture(async ({ gmail, queue, sync, thread, submit, advance, now }) => {
        gmail.remove('m1')
        gmail.remove('m2')
        gmail.add('self', {
          threadId: 'thread',
          from: gmail.address,
          labels: ['INBOX', 'SENT'],
        })
        await sync.incremental()

        const archive = submit({ kind: 'archive', threadId: THREAD })
        await queue.tick()
        expect(await gmail.getMessageLabels('self')).toEqual(['SENT'])
        submit({ kind: 'undo', mutationId: archive.id })
        await queue.tick()
        await sync.incremental()
        expect(thread()?.inInbox).toBe(true)

        const modify = gmail.modifyMessage.bind(gmail)
        const writes = vi.spyOn(gmail, 'modifyMessage').mockImplementationOnce(async (...args) => {
          const result = await modify(...args)
          // A follow-up message read can have a newer revision than the Inbox removal.
          gmail.setLabels('self', ['SENT', 'STARRED'])
          if (ownerHandled) flipAwayAndBack(gmail, 'self', 'INBOX')
          return { labelIds: result.labelIds }
        })
        const until = now() + 120_000
        submit({ kind: 'snooze', threadId: THREAD, until })
        await queue.tick()
        expect(thread()).toMatchObject({ inInbox: false, snoozedUntil: until })
        await sync.incremental()

        advance(120_000)
        await queue.tick()
        expect(thread()).toMatchObject({ inInbox: !ownerHandled, snoozedUntil: null })
        expect(await gmail.getMessageLabels('self')).toEqual(
          ownerHandled ? ['SENT', 'STARRED'] : ['SENT', 'STARRED', 'INBOX'],
        )
        expect(writes.mock.calls).toEqual(
          ownerHandled
            ? [['self', [], ['INBOX']]]
            : [
                ['self', [], ['INBOX']],
                ['self', ['INBOX'], []],
              ],
        )
      })
    },
  )

  it('consumes a Snooze after the owner restores and archives it before the deadline', async () => {
    await withFixture(async ({ gmail, queue, sync, thread, submit, advance, now }) => {
      submit({ kind: 'snooze', threadId: THREAD, until: now() + 1000 })
      await queue.tick()
      gmail.setLabels('m1', ['INBOX', 'UNREAD'])
      await sync.incremental()
      gmail.setLabels('m1', ['UNREAD'])
      await sync.incremental()
      const write = vi.spyOn(gmail, 'modifyMessage')
      advance(1000)
      await queue.tick()
      expect(thread()).toMatchObject({ inInbox: false, snoozedUntil: null })
      expect(write).not.toHaveBeenCalled()
    })
  })

  it('keeps a throttled wake across restart and reauthentication', async () => {
    await withFixture(async ({ db, gmail, store, queue, thread, submit, advance, now }) => {
      const until = now() + 1000
      submit({ kind: 'snooze', threadId: THREAD, until })
      await queue.tick()
      advance(1000)
      gmail.batchFailure = { applied: 0, error: new GmailHttpError(429, '', 'retry later') }
      await queue.tick()
      db.prepare("UPDATE account SET status = 'auth_expired' WHERE id = 'a'").run()
      let authenticated = false
      const restarted = new Mutations(store, () => (authenticated ? gmail : null), silentLog, {
        now,
        snoozeEnabled: true,
      })
      advance(2000)
      await restarted.tick()
      expect(thread()).toMatchObject({ inInbox: false, snoozedUntil: until })
      authenticated = true
      db.prepare("UPDATE account SET status = 'ready' WHERE id = 'a'").run()
      await restarted.tick()
      expect(thread()).toMatchObject({ inInbox: true, snoozedUntil: null })
    })
  })

  it('wakes when Gmail recovers after nine pre-commit throttles', async () => {
    await withFixture(async ({ gmail, queue, thread, submit, advance, now }) => {
      const until = now() + 1000
      submit({ kind: 'snooze', threadId: THREAD, until })
      await queue.tick()
      advance(1000)
      const write = vi.spyOn(gmail, 'modifyMessage')
      for (let i = 0; i < 9; i++) {
        gmail.batchFailure = { applied: 0, error: new GmailHttpError(429, '', 'retry later') }
        await queue.tick()
        expect(thread()).toMatchObject({ inInbox: false, snoozedUntil: until })
        await queue.tick()
        expect(write).toHaveBeenCalledTimes(i + 1)
        advance(300_000)
      }
      await queue.tick()
      expect(thread()).toMatchObject({ inInbox: true, snoozedUntil: null })
    })
  })

  it('wakes when Snooze was acknowledged without a Gmail revision', async () => {
    await withFixture(async ({ gmail, queue, thread, submit, advance, now }) => {
      const modify = gmail.modifyMessage.bind(gmail)
      vi.spyOn(gmail, 'modifyMessage').mockImplementationOnce(async (...args) => ({
        labelIds: (await modify(...args)).labelIds,
        historyId: undefined,
      }))
      submit({ kind: 'snooze', threadId: THREAD, until: now() + 1000 })
      await queue.tick()
      advance(1000)
      await queue.tick()
      expect(thread()).toMatchObject({ inInbox: true, snoozedUntil: null })
    })
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
    await new Mutations(store, () => gmail, silentLog, { now, snoozeEnabled: true }).tick()
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
      async (input, options) => {
        const url = new URL(String(input))
        if (url.pathname.endsWith('/history')) {
          const page = await gmail.history(url.searchParams.get('startHistoryId') ?? '')
          return Response.json(page)
        }
        if (options?.method === 'GET') {
          trace.push('read')
          return Response.json({ messages: await gmail.getThreadMessages('thread') })
        }
        trace.push('write')
        if (trace.filter((event) => event === 'write').length === 1)
          return Response.json({}, { status: 401 })
        return Response.json(await gmail.setTrashed('m1', true))
      },
      { limiter: new QuotaLimiter({ rate: 10_000, maxRate: 10_000 }) },
    )
    const queue = new Mutations(store, () => api, silentLog, { now, snoozeEnabled: true })
    const action = submit({ kind: 'trash', value: true, threadId: THREAD })
    await queue.tick()
    expect(lookup(action.id)?.status).toBe('pending')
    advance(2000)
    await queue.tick()
    expect(trace).toEqual(['read', 'read', 'write', 'refresh', 'read', 'read'])
    expect(lookup(action.id)).toMatchObject({ status: 'applied', superseded: ['a:m1'] })
    expect(await gmail.getMessageLabels('m1')).toEqual(['UNREAD', 'INBOX'])
  })

  it.each(['restore', 'trash', 'delete'] as const)(
    'consumes the schedule after a fresh read sees owner action %s',
    async (edit) => {
      await withFixture(async ({ gmail, queue, submit, advance, now, thread }) => {
        submit({ kind: 'snooze', until: now() + 1000, threadId: THREAD })
        await queue.tick()
        if (edit === 'restore') gmail.setLabels('m1', ['INBOX', 'UNREAD'])
        if (edit === 'trash') gmail.setLabels('m1', ['TRASH', 'UNREAD'])
        if (edit === 'delete') {
          gmail.remove('m1')
          gmail.remove('m2')
        }
        const writes = vi.spyOn(gmail, 'modifyMessage')
        advance(1000)
        await queue.tick()
        await queue.tick()
        expect(writes).not.toHaveBeenCalled()
        expect(thread()?.snoozedUntil).toBeNull()
      })
    },
  )

  it.each([false, true])('undoes Snooze subject to a fresh Trash check (%s)', async (trashed) => {
    await withFixture(async ({ gmail, queue, submit, now, thread }) => {
      const snooze = submit({ kind: 'snooze', until: now() + 1000, threadId: THREAD })
      await queue.tick()
      if (trashed) gmail.setLabels('m1', ['TRASH', 'UNREAD'])
      submit({ kind: 'undo', mutationId: snooze.id })
      await queue.tick()
      expect(thread()?.snoozedUntil).toBeNull()
      expect((await gmail.getMessageLabels('m2'))?.includes('INBOX')).toBe(!trashed)
    })
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
      const store = new MailStore(db, new BlobStore(directory), { now })
      const restarted = new Mutations(store, () => gmail, silentLog, { now, snoozeEnabled: true })
      await restarted.tick()
      expect(write.mock.calls).toEqual([
        ['m1', true],
        ['m2', true],
        ['m1', false],
      ])
      expect(restarted.lookup(REQUESTOR, [undo.id])[0]).toMatchObject({
        status: 'failed',
        error: 'A change to Trash may have been applied',
        messages: [{ messageId: 'a:m1', status: 'uncertain', uncertainLabels: ['a:TRASH'] }],
      })
      expect(await gmail.getMessageLabels('m1')).toEqual(['INBOX', 'UNREAD', 'TRASH'])
      expect(new MailQueries(db).thread(THREAD)?.inInbox).toBe(false)
    } finally {
      db.close()
      rmSync(directory, { recursive: true, force: true })
    }
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
  ] as const

  it.each(paths)('re-reads Gmail after an ambiguous write on $kind $value', async (path) => {
    const { gmail, queue, store, sync, submit, now, advance, db } = await setup()
    if (path.kind === 'trash' && !path.value) gmail.setLabels('m1', ['INBOX', 'UNREAD', 'TRASH'])
    if (path.kind === 'undo') {
      submit({ kind: 'archive', threadId: THREAD })
      await queue.tick()
    }
    if (path.kind === 'wake') {
      submit({ kind: 'snooze', threadId: THREAD, until: now() + 1000 })
      await queue.tick()
      advance(1000)
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
      if (dispatched) return
      faultAt = reads
      dispatched = key
      if (write.kind === 'trash') gmail.trashFailure = { afterWrite: true, error: failure() }
      else gmail.batchFailure = { applied: write.ids.length, error: failure() }
    }
    await queue.tick()
    expect(dispatched).toBeDefined()
    expect(db.prepare("SELECT 1 FROM mutation WHERE status = 'pending'").get()).toBeDefined()
    advance(2000)
    await new Mutations(store, () => gmail, silentLog, { now, snoozeEnabled: true }).tick()
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
    const snoozeEnabled = process.env.AMC_FUZZ_SNOOZE === '1'
    const failingSeed = process.env.AMC_FUZZ_SEED
    const seeds = failingSeed
      ? [Number(failingSeed)]
      : Array.from(
          { length: Number(process.env.AMC_FUZZ_COUNT ?? 512) },
          (_, i) => i + Number(process.env.AMC_FUZZ_START ?? 1),
        )
    try {
      for (const [index, seed] of seeds.entries()) {
        // Large shards must let Vitest's worker process messages between scenarios.
        if (index % 32 === 0) await new Promise<void>((resolve) => setImmediate(resolve))
        const {
          db,
          gmail,
          store,
          state,
          now,
          advance,
          queue: initialQueue,
          sync: initialSync,
        } = await setup(directory, undefined, snoozeEnabled)
        const pick = seededRandom(seed)
        const targeted = seededRandom(seed ^ 0x6fa97c03)
        const trace: string[] = []
        let queue = initialQueue
        let sync = initialSync
        if (snoozeEnabled) {
          gmail.labelList.push({ id: 'Label_legacy', name: SNOOZED_LABEL, type: 'user' })
          await sync.syncLabels()
        }
        let reply = 2
        let ownerEditedAfterRead = false
        const active = () =>
          db
            .prepare(
              "SELECT id, request, intent_id FROM mutation WHERE status = 'pending' ORDER BY seq LIMIT 1",
            )
            .get()
        const ownerEdit = (phase: string) => {
          const ids = [...gmail.messages.keys()]
          const id = ids[pick(ids.length)] ?? ''
          const choices = phase === 'during backoff' ? 11 : phase === 'before planning' ? 10 : 9
          const edits = Array.from({ length: choices }, (_, i) => i)
            .map((edit) => (phase === 'before planning' && edit === 9 ? 10 : edit))
            .filter((edit) => snoozeEnabled || (edit !== 6 && edit !== 10))
          const edit = ids.length < 2 ? 8 : (edits[pick(edits.length)] ?? 8)
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
            case 9:
              flipAwayAndBack(
                gmail,
                id,
                ['TRASH', 'INBOX', 'STARRED', 'UNREAD', 'Label_work'][pick(5)] ?? 'INBOX',
              )
              return
            case 6:
            case 10: {
              const marker = gmail.labelList.find((label) => label.name === SNOOZED_LABEL)
              if (marker) {
                if (edit === 6) labels.delete(marker.id)
                else labels.add(marker.id)
              }
              break
            }
          }
          gmail.setLabels(id, [...labels])
        }
        const restart = () => {
          trace.push('restart')
          queue = new Mutations(store, () => gmail, silentLog, { now, snoozeEnabled })
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
            const marker = gmail.labelList.find(({ name }) => name === SNOOZED_LABEL)?.id
            if (!present && label === marker)
              throw new Error(`Removed an owner-applied Snooze marker: ${id}`)
            if (owner.revision > (snapshot?.revision ?? 0))
              throw new Error(`Overwrote owner write after dispatch read: ${id} ${label}`)
            const row = active()
            const baseline = row && baselines.get(String(row.id))?.get(id)
            if (baseline && owner.revision > baseline.revision)
              throw new Error(`Overwrote a visible owner change: ${id} ${label}`)
          } catch (error) {
            violation ??= error
          }
        }
        gmail.beforeWrite = (write) => {
          trace.push(`dispatch ${JSON.stringify(write)}`)
          try {
            expect(reads).toBeGreaterThan(lastDispatch)
            const row = active()
            expect(row).toBeDefined()
            const marker = gmail.labelList.find(({ name }) => name === SNOOZED_LABEL)?.id
            if (marker && write.kind === 'batch') {
              expect(write.remove).not.toContain(marker)
              expect(write.add).not.toContain(marker)
            }
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
            ]
            if (snoozeEnabled) {
              actions.push({
                kind: 'snooze',
                until: now() + 1000,
                noReply: Boolean(pick(2)),
                threadId: THREAD,
              })
            } else {
              actions.push(
                { kind: 'read', value: true, threadId: THREAD },
                { kind: 'read', value: false, threadId: THREAD },
              )
            }
            actions.push(
              { kind: 'mute', value: Boolean(pick(2)), threadId: THREAD },
              { kind: 'undo', threadId: THREAD },
            )
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
                  ![
                    'There is no matching action to undo',
                    'Undo unavailable: Mute has changed since this action',
                    'Undo unavailable: Snooze has changed since this action',
                  ].includes(error.message)
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
          const scenarios = [
            ...(snoozeEnabled
              ? [(fixture: OrganiseFixture) => checkWake(fixture, Boolean(targeted(2)))]
              : []),
            (fixture: OrganiseFixture) =>
              checkMuteSuppression(
                fixture,
                [undefined, lostResponse(), committed503()][targeted(3)],
                Boolean(targeted(2)),
              ),
            (fixture: OrganiseFixture) =>
              checkStaleReconciliation(
                fixture,
                targeted(2) ? 'STARRED' : 'Label_work',
                Boolean(targeted(2)),
              ),
            (fixture: OrganiseFixture) => checkExpiredTrash(fixture, targeted(2) ? 401 : 503),
            (fixture: OrganiseFixture) =>
              checkAmbiguousTrash(
                fixture,
                targeted(2) ? lostResponse() : committed503(),
                Boolean(targeted(2)),
              ),
          ]
          scenarios.push(
            (fixture) =>
              checkUndoAba(fixture, targeted(2) ? 'TRASH' : 'Label_work', targeted(2) ? 1 : 500),
            (fixture) => checkRetryAba(fixture, targeted(2) ? 'm1' : 'm2', targeted(2) ? 429 : 401),
            (fixture) => {
              fixture.gmail.historyPageSize = targeted(2) ? 1 : 500
              return checkSuppressionOwnerEdit(fixture, Boolean(targeted(2)))
            },
          )
          if (snoozeEnabled)
            scenarios.push((fixture) => checkWakeInboxEdit(fixture, Boolean(targeted(2))))
          const scenario = targeted(scenarios.length)
          trace.push(`targeted interleaving ${scenario}`)
          const runScenario = scenarios[scenario]
          if (runScenario) await withFixture(runScenario, directory, snoozeEnabled)
        } catch (error) {
          console.error(
            `Gmail interleaving failed for seed ${seed}. Replay with AMC_FUZZ_SNOOZE=${Number(snoozeEnabled)} AMC_FUZZ_SEED=${seed}\n${trace.join('\n')}`,
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

type OrganiseFixture = Awaited<ReturnType<typeof setup>>

async function checkMuteSuppression(
  { db, gmail, queue, sync, submit, advance, now, store }: OrganiseFixture,
  failure: Error | undefined,
  syncRestore: boolean,
) {
  submit({ kind: 'mute', value: true, threadId: THREAD })
  await queue.tick()
  gmail.add('m3', { threadId: 'thread' })
  await sync.incremental()
  const writes: string[] = []
  gmail.beforeWrite = (write) => {
    if (write.kind === 'batch' && write.remove.includes('INBOX')) writes.push(...write.ids)
  }
  if (failure) gmail.batchFailure = { applied: 1, error: failure }
  await queue.tick()
  expect(await gmail.getMessageLabels('m3')).not.toContain('INBOX')
  gmail.setLabels('m3', ['INBOX', 'UNREAD'])
  if (syncRestore) await sync.incremental()
  advance(2000)
  const restarted = new Mutations(store, () => gmail, silentLog, { now, snoozeEnabled: true })
  await restarted.tick()
  await restarted.tick()
  expect(await gmail.getMessageLabels('m3')).toContain('INBOX')
  expect(writes).toEqual(['m3'])
  expect(
    db
      .prepare(
        "SELECT status FROM organise_intent_message WHERE message_id = 'a:m3' AND work = 'suppress'",
      )
      .get(),
  ).toEqual({ status: failure ? 'superseded' : 'done' })

  // Apply history since the last sync, with a freshly restored older reply and a fresh delivery.
  gmail.add('m4', { threadId: 'thread', labels: ['UNREAD'] })
  gmail.setLabels('m4', ['INBOX', 'UNREAD'])
  gmail.add('m5', { threadId: 'thread' })
  await sync.incremental()
  await restarted.tick()
  expect(writes).toEqual(['m3', 'm5'])
  expect(await gmail.getMessageLabels('m4')).toContain('INBOX')
  expect(await gmail.getMessageLabels('m5')).not.toContain('INBOX')
}

async function checkStaleReconciliation(
  { db, gmail, queue, sync, submit, lookup }: OrganiseFixture,
  edit: 'STARRED' | 'Label_work',
  viaMessageGet: boolean,
) {
  const get = gmail.getThreadMessages.bind(gmail)
  let acknowledged = false
  const batch = gmail.batchModify.bind(gmail)
  vi.spyOn(gmail, 'batchModify').mockImplementation(async (...args) => {
    const result = await batch(...args)
    acknowledged = true
    return result
  })
  const ownerEdit = async () => {
    acknowledged = false
    gmail.setLabels('m1', ['INBOX', 'UNREAD', edit])
    await sync.incremental()
  }
  vi.spyOn(gmail, 'getThreadMessages').mockImplementation(async (id) => {
    const snapshot = await get(id)
    if (!acknowledged) return snapshot
    if (viaMessageGet) {
      gmail.afterLabelRead = ownerEdit
      return snapshot.filter((message) => message.id !== 'm1')
    }
    await ownerEdit()
    return snapshot
  })
  const action = submit({ kind: 'read', value: true, threadId: THREAD })
  await queue.tick()
  expect(acknowledged).toBe(false)
  expect(lookup(action.id)?.status).toBe('applied')
  expect(await sync.incremental()).toBe(0)
  const provider = db
    .prepare("SELECT provider_label_ids, provider_history_id FROM message WHERE id = 'a:m1'")
    .get()
  expect(provider).toEqual({
    provider_label_ids: JSON.stringify(['INBOX', 'UNREAD', edit].map((id) => `a:${id}`)),
    provider_history_id: gmail.messages.get('m1')?.historyId,
  })
}

async function checkExpiredTrash(
  { db, gmail, queue, store, submit, advance, now }: OrganiseFixture,
  expiry: 401 | 503,
) {
  const write = gmail.setTrashed.bind(gmail)
  const spy = vi.spyOn(gmail, 'setTrashed').mockImplementation(async (id, value) => {
    if (id === 'm2') throw new GmailHttpError(expiry, '', 'interrupted')
    return write(id, value)
  })
  const action = submit({ kind: 'trash', value: true, threadId: THREAD })
  await queue.tick()
  expect(await gmail.getMessageLabels('m1')).toContain('TRASH')
  db.exec("UPDATE account SET status = 'auth_expired' WHERE id = 'a'")
  advance(2000)
  await new Mutations(store, () => null, silentLog, { now, snoozeEnabled: true }).tick()
  expect(spy.mock.calls).toEqual([
    ['m1', true],
    ['m2', true],
  ])
  const restarted = new Mutations(store, () => gmail, silentLog, { now, snoozeEnabled: true })
  const result = restarted.lookup(REQUESTOR, [action.id])[0]
  expect(result).toMatchObject({
    status: 'partial',
    messages: [
      { messageId: 'a:m1', appliedLabels: ['a:TRASH'] },
      expiry === 401
        ? { messageId: 'a:m2', failedLabels: ['a:TRASH'] }
        : { messageId: 'a:m2', uncertainLabels: ['a:TRASH'] },
    ],
  })
  db.exec("UPDATE account SET status = 'ready' WHERE id = 'a'")
  const undo = restarted.submit(REQUESTOR, [
    {
      id: randomUUID(),
      action: { kind: 'undo', mutationId: action.id },
    },
  ])[0]
  await restarted.tick()
  expect(restarted.lookup(REQUESTOR, [undo?.id ?? ''])[0]?.status).toBe('applied')
  expect(spy.mock.calls).toEqual([
    ['m1', true],
    ['m2', true],
    ['m1', false],
  ])
}

async function checkAmbiguousTrash(
  { db, gmail, queue, store, submit, advance, now, lookup }: OrganiseFixture,
  failure: Error,
  ownerRestores: boolean,
) {
  gmail.trashFailure = { afterWrite: true, error: failure }
  const action = submit({ kind: 'trash', value: true, threadId: THREAD })
  await queue.tick()
  expect(lookup(action.id)?.status).toBe('pending')
  if (ownerRestores) gmail.setLabels('m1', ['INBOX', 'UNREAD'])
  gmail.trashFailure = { afterWrite: false, error: new GmailHttpError(403, '', 'refused') }
  advance(2000)
  await new Mutations(store, () => gmail, silentLog, { now, snoozeEnabled: true }).tick()
  const result = lookup(action.id)
  expect(result).toMatchObject({
    status: 'failed',
    error: expect.stringContaining('may have been applied'),
    superseded: [],
    messages: [
      { messageId: 'a:m1', status: 'uncertain', appliedLabels: [], uncertainLabels: ['a:TRASH'] },
      { messageId: 'a:m2', status: 'failed', failedLabels: ['a:TRASH'] },
    ],
  })
  const replica = db.prepare("SELECT provider_label_ids FROM message WHERE id = 'a:m1'").get()
  expect(JSON.parse(String(replica?.provider_label_ids)).includes('a:TRASH')).toBe(!ownerRestores)
  expect(() => submit({ kind: 'undo', mutationId: action.id })).toThrow(
    'There is no matching action',
  )
}

async function checkWake(
  { gmail, queue, submit, now, advance, thread }: OrganiseFixture,
  ownerDeletes: boolean,
) {
  submit({ kind: 'snooze', threadId: THREAD, until: now() + 1000 })
  await queue.tick()
  const getThread = gmail.getThreadMessages.bind(gmail)
  const batch = gmail.batchModify.bind(gmail)
  const wakeTargets: string[] = []
  let ownerEdited = false
  vi.spyOn(gmail, 'batchModify').mockImplementation(async (ids, add, remove) => {
    const result = await batch(ids, add, remove)
    if (add.includes('INBOX')) wakeTargets.push(...ids)
    return result
  })
  vi.spyOn(gmail, 'getThreadMessages').mockImplementation(async (id) => {
    if (!ownerEdited && wakeTargets.length > 0) {
      const labels = (await gmail.getMessageLabels('m2')) ?? []
      expect(labels).toContain('INBOX')
      if (ownerDeletes) gmail.remove('m2')
      else gmail.setLabels('m2', [...labels, 'TRASH'])
      ownerEdited = true
    }
    return getThread(id)
  })
  advance(1000)
  await queue.tick()
  await queue.tick()
  expect(ownerEdited).toBe(true)
  expect(wakeTargets).toEqual(['m2'])
  expect(await gmail.getMessageLabels('m1')).not.toContain('INBOX')
  expect(thread()?.snoozedUntil).toBeNull()
}

async function withFixture(
  run: (fixture: OrganiseFixture) => Promise<void>,
  directory?: string,
  snoozeEnabled = true,
): Promise<void> {
  const fixture = await setup(directory, undefined, snoozeEnabled)
  try {
    await run(fixture)
  } finally {
    fixture.db.close()
  }
}

const lostResponse = () => new Error('connection lost')
const committed503 = () => new GmailHttpError(503, 'backendError', 'response failed')

describe('Gmail scheduler and reconciliation regressions', () => {
  it.each([false, true])(
    'consumes an acknowledged wake even when the owner deletes=%s',
    async (deletes) => {
      await withFixture((fixture) => checkWake(fixture, deletes))
    },
  )

  it.each([lostResponse, committed503, () => undefined])(
    'suppresses each muted reply at most once (%#)',
    async (failure) => {
      await withFixture((fixture) => checkMuteSuppression(fixture, failure(), false))
    },
  )

  it.each([false, true])(
    'keeps newer history when final reconciliation uses messages.get=%s',
    async (viaMessageGet) => {
      await withFixture((fixture) => checkStaleReconciliation(fixture, 'STARRED', viaMessageGet))
    },
  )

  it.each([401, 503] as const)(
    'keeps acknowledged Trash Undo-able after losing OAuth following HTTP %s',
    async (expiry) => {
      await withFixture((fixture) => checkExpiredTrash(fixture, expiry))
    },
  )

  it.each([lostResponse, committed503])(
    're-reads a lost Trash response and reports uncertainty after a refusal (%#)',
    async (failure) => {
      await withFixture((fixture) => checkAmbiguousTrash(fixture, failure(), false))
    },
  )
})

function flipAwayAndBack(gmail: FakeGmail, id: string, label: string) {
  const labels = [...(gmail.messages.get(id)?.labelIds ?? [])]
  gmail.setLabels(
    id,
    labels.includes(label) ? labels.filter((item) => item !== label) : [...labels, label],
  )
  gmail.setLabels(id, labels)
}

async function checkUndoAba(
  { gmail, queue, submit, sync, lookup }: OrganiseFixture,
  label: 'TRASH' | 'Label_work',
  pageSize: number,
) {
  const action = submit(
    label === 'TRASH'
      ? { kind: 'trash', value: true, threadId: THREAD }
      : { kind: 'label', labelId: 'a:Label_work', value: true, threadId: THREAD },
  )
  await queue.tick()
  await sync.incremental()
  gmail.historyPageSize = pageSize
  // Undo must inspect changes even after sync has consumed them.
  flipAwayAndBack(gmail, 'm1', label)
  flipAwayAndBack(gmail, 'm2', 'UNREAD')
  await sync.incremental()
  const undo = submit({ kind: 'undo', mutationId: action.id })
  await queue.tick()
  expect(await gmail.getMessageLabels('m1')).toContain(label)
  expect(await gmail.getMessageLabels('m2')).not.toContain(label)
  expect(lookup(undo.id)).toMatchObject({ status: 'applied', superseded: ['a:m1'] })
}

async function checkRetryAba(
  { gmail, queue, submit, sync, advance, store, now }: OrganiseFixture,
  target: 'm1' | 'm2',
  status: number,
) {
  const write = gmail.setTrashed.bind(gmail)
  let refused = false
  const calls: string[] = []
  gmail.setTrashed = async (id, value) => {
    calls.push(id)
    if (id === target && !refused) {
      refused = true
      throw new GmailHttpError(status, '', 'refused before the write')
    }
    return write(id, value)
  }
  submit({ kind: 'trash', value: true, threadId: THREAD })
  await queue.tick()
  flipAwayAndBack(gmail, target, 'TRASH')
  await sync.incremental()
  advance(2000)
  await new Mutations(store, () => gmail, silentLog, { now, snoozeEnabled: true }).tick()
  expect(calls.filter((id) => id === target)).toHaveLength(1)
  expect(await gmail.getMessageLabels(target)).not.toContain('TRASH')
  expect(await gmail.getMessageLabels(target === 'm1' ? 'm2' : 'm1')).toContain('TRASH')
}

describe('Gmail history attribution', () => {
  it.each(['TRASH', 'Label_work'] as const)(
    'preserves owner %s ABA edits before Undo first reads Gmail',
    async (label) => {
      await withFixture((fixture) => checkUndoAba(fixture, label, 1))
    },
  )

  it('preserves the owner untrash during quota backoff across restart', async () => {
    await withFixture((fixture) => checkRetryAba(fixture, 'm1', 429))
  })

  it('leaves all labels on the message alone when its history checkpoint has expired', async () => {
    await withFixture(async ({ gmail, queue, submit, lookup }) => {
      const star = submit({ kind: 'star', value: true, threadId: THREAD })
      await queue.tick()
      flipAwayAndBack(gmail, 'm1', 'UNREAD')
      gmail.oldestHistory = Number(gmail.messages.get('m1')?.historyId)
      const undo = submit({ kind: 'undo', mutationId: star.id })
      await queue.tick()
      expect(await gmail.getMessageLabels('m1')).toContain('STARRED')
      expect(lookup(undo.id)).toMatchObject({ status: 'applied', superseded: ['a:m1'] })
    })
  })

  it('consumes a committed wake with a lost response even when the owner trashes its target', async () => {
    await withFixture(async ({ gmail, queue, submit, now, advance }) => {
      submit({ kind: 'snooze', threadId: THREAD, until: now() + 1000 })
      await queue.tick()
      const write = vi.spyOn(gmail, 'batchModify')
      gmail.batchFailure = { applied: 1, error: committed503() }
      advance(1000)
      await queue.tick()
      const labels = (await gmail.getMessageLabels('m2')) ?? []
      expect(labels).toContain('INBOX')
      gmail.setLabels('m2', [...labels.filter((label) => label !== 'INBOX'), 'TRASH'])
      advance(2000)
      await queue.tick()
      expect(
        write.mock.calls.filter(([, added]) => added.includes('INBOX')).map(([ids]) => ids),
      ).toEqual([['m2']])
      expect(await gmail.getMessageLabels('m1')).not.toContain('INBOX')
    })
  })

  it('records a matching Star change after a lost response without attributing it to another editor', async () => {
    await withFixture(async ({ gmail, queue, submit, advance, lookup }) => {
      const write = vi.spyOn(gmail, 'batchModify')
      gmail.batchFailure = { applied: 1, error: lostResponse() }
      const action = submit({ kind: 'star', value: true, threadId: THREAD })
      await queue.tick()
      advance(2000)
      await queue.tick()
      expect(write).toHaveBeenCalledTimes(1)
      expect(await gmail.getMessageLabels('m1')).toContain('STARRED')
      expect(lookup(action.id)).toMatchObject({
        status: 'applied',
        superseded: [],
        messages: [
          {
            messageId: 'a:m1',
            status: 'uncertain',
            uncertainLabels: ['a:STARRED'],
          },
        ],
      })
    })
  })
})

it.each(['expiry', 'revocation'])(
  'cancels a queued Agent write on %s while waiting for Gmail quota',
  async (end) => {
    await withFixture(async ({ db, gmail, store, now, advance }) => {
      const clock = vi.spyOn(Date, 'now').mockImplementation(now)
      try {
        const tokens = new AccessTokens(
          { clientId: 'client', clientSecret: 'secret' },
          { refreshToken: 'token', scope: '' },
          () => Promise.reject(new Error('Unexpected OAuth refresh')),
        )
        tokens.seed('synthetic-token', now() + 2 * DAY_MS)
        const limiter = new QuotaLimiter()
        const quota = vi.spyOn(limiter, 'take').mockImplementation(async (cost) => {
          if (cost !== QUOTA_COST.modify) return
          if (end === 'expiry') advance(DAY_MS)
          else revokeToken(db, token.id, now())
        })
        const fetchGmail = vi.fn<typeof fetch>(async (input, init) => {
          const url = new URL(String(input))
          if (init?.method === 'POST') return Response.json({})
          if (url.pathname.endsWith('/threads/thread'))
            return Response.json({ messages: await gmail.getThreadMessages('thread') })
          if (url.pathname.endsWith('/history'))
            return Response.json(await gmail.history(url.searchParams.get('startHistoryId') ?? ''))
          throw new Error(`Unexpected Gmail request ${url.pathname}`)
        })
        const token = issueToken(
          db,
          {
            kind: 'agent',
            name: 'test',
            scopes: ['organize'],
            expiresAt: now() + DAY_MS,
            accountId: 'a',
          },
          now(),
        )
        const principal = authenticate(db, token.secret, now())
        if (!principal) throw new Error('Missing Agent grant')
        const queue = new Mutations(
          store,
          () => new GmailHttpApi(tokens, fetchGmail, { limiter }),
          silentLog,
          { now },
        )
        const submitted = organizeAsAgent(db, queue, principal, 'star', [
          { kind: 'star', threadId: THREAD, value: true },
        ])
        expect(submitted.error).toBeNull()
        await queue.tick()
        expect(quota).toHaveBeenCalledWith(QUOTA_COST.modify, true)
        expect(fetchGmail.mock.calls.some(([, init]) => init?.method === 'POST')).toBe(false)
        expect(agentAction(db, queue, token.id, submitted.id)).toMatchObject({
          status: 'failed',
          mutations: [
            {
              status: 'failed',
              error: 'Agent grant expired',
              messages: [
                { messageId: 'a:m1', status: 'failed', failedLabels: ['a:STARRED'] },
                { messageId: 'a:m2', status: 'failed', failedLabels: [] },
              ],
            },
          ],
        })
      } finally {
        clock.mockRestore()
      }
    })
  },
)

it('distinguishes a lost Star acknowledgement from an owner edit when history expires', async () => {
  const { gmail, queue, submit, advance, lookup } = await setup()
  gmail.batchFailure = { applied: 1, error: new Error('response lost') }
  const action = submit({ kind: 'star', value: true, threadId: THREAD })
  await queue.tick()
  gmail.oldestHistory = Number((await gmail.profile()).historyId)
  advance(2000)
  await queue.tick()
  expect(await gmail.getMessageLabels('m1')).toContain('STARRED')
  expect(lookup(action.id)).toMatchObject({
    superseded: [],
    messages: [{ messageId: 'a:m1', status: 'uncertain', uncertainLabels: ['a:STARRED'] }],
  })
})

async function checkSuppressionOwnerEdit(
  { db, gmail, queue, submit, sync, now, advance, store }: OrganiseFixture,
  retry: boolean,
) {
  const intent = submit({ kind: 'mute', threadId: THREAD, value: true })
  await queue.tick()
  gmail.add('m3', { threadId: 'thread', labels: ['INBOX', 'UNREAD'] })
  await sync.incremental()
  const attempts = vi.spyOn(gmail, 'modifyMessage')
  if (retry) {
    gmail.batchFailure = {
      applied: 0,
      error: new GmailHttpError(429, 'rateLimitExceeded', 'refused'),
    }
    await queue.tick()
    expect(attempts).toHaveBeenCalledTimes(1)
  }
  flipAwayAndBack(gmail, 'm3', 'INBOX')
  await sync.incremental()
  advance(2000)
  const restarted = new Mutations(store, () => gmail, silentLog, { now, snoozeEnabled: true })
  await restarted.tick()
  expect(await gmail.getMessageLabels('m3')).toContain('INBOX')
  await restarted.tick()
  expect(await gmail.getMessageLabels('m3')).toContain('INBOX')
  expect(attempts).toHaveBeenCalledTimes(retry ? 1 : 0)
  expect(
    db
      .prepare(
        "SELECT status FROM organise_intent_message WHERE intent_id = ? AND message_id = 'a:m3' AND work = 'suppress'",
      )
      .get(intent.id),
  ).toEqual({ status: 'superseded' })

  gmail.add('m4', { threadId: 'thread' })
  await sync.incremental()
  await restarted.tick()
  expect(await gmail.getMessageLabels('m3')).toContain('INBOX')
  expect(await gmail.getMessageLabels('m4')).not.toContain('INBOX')
}

async function checkWakeInboxEdit(
  { gmail, queue, submit, advance, now, thread }: OrganiseFixture,
  retry: boolean,
) {
  submit({ kind: 'snooze', threadId: THREAD, until: now() + 1000 })
  await queue.tick()
  advance(1000)
  const attempts = vi.spyOn(gmail, 'modifyMessage')
  if (retry) {
    gmail.batchFailure = {
      applied: 0,
      error: new GmailHttpError(429, 'rateLimitExceeded', 'refused'),
    }
    await queue.tick()
  }
  const edit = () => flipAwayAndBack(gmail, 'm2', 'INBOX')
  if (retry) edit()
  else gmail.afterThreadRead = edit
  advance(2000)
  await queue.tick()
  await queue.tick()
  expect(thread()?.snoozedUntil).toBeNull()
  expect(attempts.mock.calls.filter(([, add]) => add.includes('INBOX'))).toHaveLength(retry ? 1 : 0)
  expect(await gmail.getMessageLabels('m1')).not.toContain('INBOX')
  expect(await gmail.getMessageLabels('m2')).not.toContain('INBOX')
}

it('preserves owner Inbox ABA before the first Mute suppression', async () => {
  await withFixture((fixture) => checkSuppressionOwnerEdit(fixture, false))
})

it('consumes a Snooze wake after the owner edits the target Inbox label', async () => {
  await withFixture((fixture) => checkWakeInboxEdit(fixture, true))
})

it('keeps an old Mute effective for witnessed deliveries after its Gmail history expires', async () => {
  await withFixture(async ({ gmail, queue, submit, sync }) => {
    submit({ kind: 'mute', threadId: THREAD, value: true })
    await queue.tick()
    gmail.add('m3', { threadId: 'thread' })
    // Let sync witness the deliveries before expiring their original Mute checkpoint.
    const firstDelivery = Number((await gmail.profile()).historyId)
    flipAwayAndBack(gmail, 'm3', 'INBOX')
    gmail.add('m4', { threadId: 'thread' })
    await sync.incremental()
    gmail.oldestHistory = firstDelivery
    await queue.tick()
    expect(await gmail.getMessageLabels('m3')).toContain('INBOX')
    expect(await gmail.getMessageLabels('m4')).not.toContain('INBOX')
  })
})

it.each([false, true])('wakes an archived reply early or after quota retry (%s)', async (retry) => {
  await withFixture(async ({ gmail, queue, sync, submit, advance, now, thread }) => {
    submit({ kind: 'snooze', threadId: THREAD, until: now() + 5000, noReply: true })
    await queue.tick()
    if (retry) {
      advance(5000)
      gmail.batchFailure = { applied: 0, error: new GmailHttpError(429, '', 'retry later') }
      await queue.tick()
    }
    advance(1000)
    gmail.add('successor', { threadId: 'thread', date: now(), labels: ['UNREAD'] })
    await sync.incremental()
    advance(1000)
    await queue.tick()
    expect(thread()).toMatchObject({ inInbox: true, snoozedUntil: null })
    expect(await gmail.getMessageLabels('successor')).toEqual(['UNREAD'])
  })
})

it('wakes an active schedule after reopening SQLite', async () => {
  const dir = tempDir()
  const path = join(dir, 'snooze.db')
  let db = openDatabase(path)
  try {
    migrate(db)
    const { gmail, queue, submit, advance, now } = await setup(dir, db)
    const until = now() + 1000
    submit({ kind: 'snooze', threadId: THREAD, until })
    await queue.tick()
    db.close()
    db = openDatabase(path)
    expect(new MailQueries(db, true).thread(THREAD)?.snoozedUntil).toBe(until)
    const restarted = new Mutations(
      new MailStore(db, new BlobStore(dir), { now }),
      () => gmail,
      silentLog,
      { now, snoozeEnabled: true },
    )
    advance(1000)
    await restarted.tick()
    expect(new MailQueries(db, true).thread(THREAD)).toMatchObject({
      inInbox: true,
      snoozedUntil: null,
    })
  } finally {
    db.close()
    rmSync(dir, { recursive: true, force: true })
  }
})

it('undoes an Agent Star without clearing a newer owner Snooze', async () => {
  await withFixture(async ({ db, gmail, queue, submit, thread, now }) => {
    const token = issueToken(db, {
      kind: 'agent',
      name: 'Agent',
      scopes: ['organize'],
      expiresAt: Date.now() + DAY_MS,
    })
    const agent = authenticate(db, token.secret)
    if (!agent) throw new Error('Missing agent')
    expect(() =>
      queue.submit(agent.tokenId, [
        {
          id: randomUUID(),
          action: { kind: 'snooze', threadId: THREAD, until: now() + 1000 },
        },
      ]),
    ).toThrow('Only the owner can Snooze mail')
    const action = organizeAsAgent(db, queue, agent, 'star_thread', [
      { kind: 'star', value: true, threadId: THREAD },
    ])
    await queue.tick()
    expect(await gmail.getMessageLabels('m1')).toContain('STARRED')
    const until = now() + 1000
    submit({ kind: 'snooze', threadId: THREAD, until })
    await queue.tick()
    queue.undoAgentAction(REQUESTOR, action.id)
    await queue.tick()
    expect(await gmail.getMessageLabels('m1')).toEqual(['UNREAD'])
    expect(thread()).toMatchObject({ inInbox: false, snoozedUntil: until })
  })
})

it.each([false, true])(
  'guards partial Agent Mute Undo when a newer Mute exists (%s)',
  async (newer) => {
    await withFixture(async ({ db, gmail, queue, submit, thread }) => {
      gmail.setLabels('m2', ['INBOX', 'STARRED'])
      const token = issueToken(db, {
        kind: 'agent',
        name: 'Agent',
        scopes: ['organize'],
        expiresAt: Date.now() + DAY_MS,
      })
      const agent = authenticate(db, token.secret)
      if (!agent) throw new Error('Missing agent')
      const modify = gmail.modifyMessage.bind(gmail)
      const provider = vi.spyOn(gmail, 'modifyMessage').mockImplementation((id, add, remove) => {
        if (id === 'm2') return Promise.reject(new GmailHttpError(403, '', 'refused'))
        return modify(id, add, remove)
      })
      const action = organizeAsAgent(db, queue, agent, 'mute_thread', [
        { kind: 'mute', value: true, threadId: THREAD },
      ])
      await queue.tick()
      expect(queue.agentResults(action.id)[0]?.status).toBe('partial')
      expect(thread()?.muted).toBe(false)
      provider.mockClear()
      if (newer) {
        submit({ kind: 'mute', value: false, threadId: THREAD })
        await queue.tick()
        expect(() => queue.undoAgentAction(REQUESTOR, action.id)).toThrow(
          'Undo unavailable: Mute has changed since this action',
        )
        return
      }
      queue.undoAgentAction(REQUESTOR, action.id)
      await queue.tick()
      expect(provider.mock.calls).toEqual([['m1', ['INBOX'], []]])
      expect(thread()?.muted).toBe(false)
      expect(await gmail.getMessageLabels('m2')).toContain('INBOX')
    })
  },
)
