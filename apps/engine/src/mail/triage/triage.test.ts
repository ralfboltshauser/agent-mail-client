import { randomUUID } from 'node:crypto'
import { join } from 'node:path'
import { Client } from '@modelcontextprotocol/sdk/client/index.js'
import { InMemoryTransport } from '@modelcontextprotocol/sdk/inMemory.js'
import { expect, it } from 'vitest'
import { authenticate, issueToken } from '../../auth/tokens.ts'
import { BlobStore } from '../../blobs.ts'
import { migrate, openDatabase } from '../../db/database.ts'
import { MIGRATIONS } from '../../db/migrations.ts'
import { createApp } from '../../http/app.ts'
import { triageRoutes } from '../../http/triage.ts'
import { buildMcpServer } from '../../mcp/server.ts'
import { FakeGmail } from '../../providers/gmail/fake.ts'
import { fromGmail } from '../../providers/gmail/mapping.ts'
import { silentLog, tempDir, testConfig } from '../../test-support.ts'
import { Drafts } from '../drafts.ts'
import { Mutations } from '../mutations.ts'
import { MailQueries } from '../queries.ts'
import { MailStore } from '../store.ts'
import { correctionActions, correctionExamples, markConfirmedReply } from './corrections.ts'
import { threadInput } from './input.ts'

function setup(legacy = false) {
  const dir = tempDir()
  const path = join(dir, 'triage.db')
  const db = openDatabase(path)
  migrate(db, {
    migrations: legacy ? MIGRATIONS.filter((migration) => migration.version < 22) : MIGRATIONS,
  })
  for (const id of ['a', 'b']) {
    db.prepare(
      "INSERT INTO account (id, kind, address, credentials, created_at) VALUES (?, 'gmail', ?, X'00', 0)",
    ).run(id, `owner-${id}@example.test`)
    db.prepare('INSERT INTO sender_scan (account_id, ready) VALUES (?, 1)').run(id)
  }
  const blobs = new BlobStore(dir)
  const store = new MailStore(db, blobs)
  const gmail = new FakeGmail()
  const put = (accountId: string, id: string, from: string, at: number, thread = id) => {
    const fixture = fromGmail(
      gmail.add(id, { from, subject: 'Fixture subject', body: 'Fixture content' }),
    )
    store.putMessage(accountId, [], {
      ...fixture,
      providerThreadId: thread,
      sentAt: at,
      deliveredAt: at,
    })
    return `${accountId}:${thread}`
  }
  const owner = issueToken(db, {
    kind: 'cli',
    name: 'Owner',
    scopes: ['admin', 'read', 'organize'],
  })
  const queries = new MailQueries(db)
  const drafts = new Drafts(db, store, () => gmail)
  const mutations = new Mutations(store, () => gmail, silentLog)
  const deps = { db, store, queries, drafts, mutations }
  const app = createApp({
    db,
    config: testConfig(),
    log: silentLog,
    mutations,
    smartInbox: { triage: triageRoutes(db), ownerActions: correctionActions(store) },
    mail: deps as never,
  })
  const http = (url: string, method = 'GET', body?: unknown, secret = owner.secret) =>
    app.request(url, {
      method,
      headers: { Authorization: `Bearer ${secret}`, 'Content-Type': 'application/json' },
      ...(body ? { body: JSON.stringify(body) } : {}),
    })
  const lease = async (accountId = 'a') => {
    const name = `triage-${randomUUID()}`
    const agent = issueToken(db, {
      kind: 'agent',
      accountId,
      name,
      scopes: ['read', 'organize'],
      expiresAt: Date.now() + 60_000,
    })
    expect(await (await http('/v1/triage/lease', 'POST', { holder: name })).json()).toEqual({
      granted: true,
    })
    const principal = authenticate(db, agent.secret)
    if (!principal) throw new Error('Could not authenticate synthetic grant')
    const server = buildMcpServer(principal, deps)
    const client = new Client({ name: 'fixture', version: '1' })
    const [a, b] = InMemoryTransport.createLinkedPair()
    await Promise.all([server.connect(a), client.connect(b)])
    const tool = async (toolName: string, args: Record<string, unknown>) => {
      const result = await client.callTool({ name: toolName, arguments: args })
      const content = (result.content as { text: string }[])[0]?.text
      if (!content || result.isError) return { error: content }
      return JSON.parse(content)
    }
    return {
      secret: agent.secret,
      list: () => tool('list_untriaged', { reviewContext: true }),
      set: (threadId: string, inputRevision: number, confidence = 'low') =>
        tool('set_bucket', {
          threadId,
          bucket: 'Later',
          reason: 'Synthetic uncertainty',
          triage: { inputRevision, confidence },
        }),
      close: () => client.close(),
    }
  }
  return { db, path, store, http, owner, put, lease, queries }
}

it('paginates grouped new Senders before explicit current low confidence with exact revisions', async () => {
  const { db, put, http, lease, queries, store } = setup()
  const alice = 'alice@example.test'
  const known = 'known@example.test'
  const agent = await lease()
  try {
    const first = put('a', 'one', alice, 5)
    const representative = put('a', 'two', alice, 5)
    const otherAccount = put('b', 'one', alice, 4)
    const low = put('a', 'low', known, 15)
    const medium = put('a', 'medium', known, 13)
    const old = put('a', 'old', known, 14)
    db.prepare("INSERT INTO sender_evidence VALUES ('a', ?, 'fixture')").run(known)
    store.setBucket({ threadId: old, bucket: 'Later', reason: 'legacy' }, 'owner')
    expect(queries.threadSummary(old)?.bucket).not.toHaveProperty('confidence')
    for (const [id, confidence] of [
      [first, 'low'],
      [low, 'low'],
      [medium, 'medium'],
    ] as const) {
      const input = threadInput(db, id)
      expect(input).toBeDefined()
      expect(await agent.set(id, input?.modseq ?? -1, confidence)).toEqual({ updated: true })
    }
    expect(queries.threadSummary(low)?.bucket).toMatchObject({ confidence: 'low' })
    const page = await (await http('/v1/triage/queue?limit=1')).json()
    expect(page.cards).toEqual([
      expect.objectContaining({
        id: { kind: 'sender', accountId: 'a', address: alice },
        threadId: representative,
        messageId: 'a:two',
        revision: 0,
        threadRevision: threadInput(db, representative)?.modseq,
      }),
    ])
    const nextUrl = `/v1/triage/queue?limit=2&cursor=${encodeURIComponent(page.cursor)}`
    const next = await (await http(nextUrl)).json()
    expect(next.revision).toBe(page.revision)
    expect(next.cards.map((card: { threadId: string }) => card.threadId)).toEqual([
      otherAccount,
      low,
    ])
    expect(next.cursor).toBeNull()
    const account = await (await http('/v1/triage/queue?accountId=b')).json()
    expect(account.cards.map((card: { threadId: string }) => card.threadId)).toEqual([otherAccount])
    expect((await http('/v1/triage/queue?limit=101')).status).toBe(400)
    expect((await http('/v1/triage/queue', 'GET', undefined, agent.secret)).status).toBe(403)
    put('a', 'new-low', known, 16, 'low')
    expect((await http(nextUrl)).status).toBe(409)
    expect(queries.threadSummary(low)?.bucket).not.toHaveProperty('confidence')
  } finally {
    await agent.close()
    db.close()
  }
})

it('rejects raced model writes and restores an assignment and prompt eligibility durably on Undo', async () => {
  const { db, path, put, http, lease, queries } = setup()
  const agent = await lease()
  try {
    const tid = put('a', 'in', 'person@example.test', 10)
    const initial = (await agent.list()).threads[0].inputRevision
    put('a', 'late', 'person@example.test', 20, 'in')
    expect(await agent.set(tid, initial)).toMatchObject({ updated: false })
    const newer = (await agent.list()).threads[0].inputRevision
    const manual = { threadId: tid, bucket: null, reason: 'Owner cleared' }
    expect((await http('/v1/bucket', 'PUT', manual)).status).toBe(200)
    expect(await agent.set(tid, newer)).toMatchObject({ updated: false })
    expect((await agent.list()).threads).toEqual([])
    put('a', 'again', 'person@example.test', 30, 'in')
    const current = (await agent.list()).threads[0].inputRevision
    expect(await agent.set(tid, current)).toMatchObject({ updated: true })
    const actionId = randomUUID()
    const review = {
      intent: 'review',
      threadId: tid,
      expectedRevision: current,
      bucket: 'Reply',
      reason: 'Owner chose Reply',
      clientActionId: actionId,
    }
    expect((await http('/v1/bucket', 'PUT', review)).status).toBe(409)
    review.expectedRevision = threadInput(db, tid)?.modseq
    expect((await http('/v1/bucket', 'PUT', review, agent.secret)).status).toBe(403)
    const applied = await (await http('/v1/bucket', 'PUT', review)).json()
    expect(applied).toMatchObject({ status: 'applied', actionId, accountId: 'a' })
    expect(await (await http('/v1/bucket', 'PUT', review)).json()).toEqual(applied)
    expect(await agent.set(tid, current)).toMatchObject({ updated: false })
    const restarted = openDatabase(path)
    try {
      const examples = [
        {
          previous: 'Later',
          chosen: 'Reply',
          context: expect.objectContaining({ subject: 'Fixture subject' }),
        },
      ]
      expect(correctionExamples(restarted, 'a')).toEqual(examples)
      expect(correctionExamples(restarted, 'b')).toEqual([])
      expect((await agent.list()).examples).toEqual(examples)
      expect(await (await http(`/v1/owner-actions/${actionId}/undo`, 'POST')).json()).toMatchObject(
        { actionId, undo: { status: 'applied' } },
      )
      expect(queries.threadSummary(tid)?.bucket).toMatchObject({
        bucket: 'Later',
        confidence: 'low',
      })
      expect(correctionExamples(restarted, 'a')).toEqual([])
      expect((await agent.list()).examples).toEqual([])
    } finally {
      restarted.close()
    }
    await http('/v1/triage/lease', 'DELETE', {
      holder: db.prepare('SELECT holder FROM triage_lease').get()?.holder,
    })
    expect(await agent.set(tid, current)).toMatchObject({ error: expect.stringContaining('lease') })
  } finally {
    await agent.close()
    db.close()
  }
})

it('upgrades populated pre-confidence databases and keeps existing Buckets outside the low-confidence tier', async () => {
  const { db, put, http, store, queries } = setup(true)
  try {
    const tid = put('a', 'legacy', 'person@example.test', 10)
    store.setBucket({ threadId: tid, bucket: 'Later', reason: 'Legacy reason' }, 'owner')
    db.prepare("INSERT INTO sender_evidence VALUES ('a', 'person@example.test', 'fixture')").run()
    expect(migrate(db)).toBe(MIGRATIONS.at(-1)?.version)
    expect(queries.threadSummary(tid)?.bucket).toEqual({
      bucket: 'Later',
      reason: 'Legacy reason',
      setBy: 'owner',
      setAt: expect.any(Number),
    })
    expect((await (await http('/v1/triage/queue')).json()).cards).toEqual([])
  } finally {
    db.close()
  }
})

it('keeps a superseding Bucket on a reimported Thread and removes the abandoned example', async () => {
  const { db, put, http, queries, store } = setup()
  try {
    const tid = put('a', 'replace', 'person@example.test', 10)
    const actionId = randomUUID()
    const review = {
      intent: 'review',
      threadId: tid,
      expectedRevision: threadInput(db, tid)?.modseq,
      bucket: 'Reply',
      reason: 'Original review',
      clientActionId: actionId,
    }
    expect((await http('/v1/bucket', 'PUT', review)).status).toBe(200)
    store.deleteMessage('a', 'replace')
    put('a', 'replace', 'person@example.test', 20)
    expect(
      (await http('/v1/bucket', 'PUT', { threadId: tid, bucket: 'Action', reason: 'New choice' }))
        .status,
    ).toBe(200)

    const undone = await (await http(`/v1/owner-actions/${actionId}/undo`, 'POST')).json()
    expect(undone).toMatchObject({ status: 'superseded', undo: { status: 'superseded' } })
    expect(queries.threadSummary(tid)?.bucket?.bucket).toBe('Action')
    expect(correctionExamples(db, 'a')).toEqual([])
  } finally {
    db.close()
  }
})

it('marks only the exact still-current incoming message after a confirmed Reply', async () => {
  const { db, put, store, http, queries } = setup()
  try {
    const threadId = put('a', 'in', 'person@example.test', 10)
    db.exec(`UPDATE message SET rfc_message_id = '<incoming@example.test>' WHERE id = 'a:in';
      INSERT INTO outbox (id, draft_id, account_id, revision, rfc_id, subject, to_json,
        send_at, undo_until, status, next_at)
      VALUES ('outbox', 'draft', 'a', 1, 'out@example.test', 'Fixture reply', '[]', 0, 0, 'queued', 0)`)
    const reply = {
      threadId,
      accountId: 'a',
      draftId: 'draft',
      revision: 1,
      providerDraftId: null,
      from: { name: null, address: 'owner-a@example.test' },
      to: [],
      cc: [],
      bcc: [],
      subject: 'Fixture reply',
      text: 'Fixture body',
      attachments: [],
      inReplyTo: 'incoming@example.test',
    }
    const receipt = { providerId: 'out', providerThreadId: 'in' }
    const review = async (bucket: string) => {
      const actionId = randomUUID()
      const response = await http('/v1/bucket', 'PUT', {
        intent: 'review',
        threadId,
        expectedRevision: threadInput(db, threadId)?.modseq,
        bucket,
        reason: 'Owner review',
        clientActionId: actionId,
      })
      expect(response.status).toBe(200)
      return actionId
    }
    markConfirmedReply(store, reply, 'out@example.test', receipt)
    expect(threadInput(db, threadId)?.handled_id).toBeNull()
    db.exec("UPDATE outbox SET status = 'sent' WHERE id = 'outbox'")
    markConfirmedReply(store, reply, 'out@example.test', {
      ...receipt,
      allRecipientsAccepted: false,
    })
    expect(threadInput(db, threadId)?.handled_id).toBeNull()
    const first = await review('Later')
    markConfirmedReply(store, reply, 'out@example.test', receipt)
    expect(threadInput(db, threadId)?.handled_id).toBe('a:in')
    const second = await review('Action')
    const undo = async (id: string) => (await http(`/v1/owner-actions/${id}/undo`, 'POST')).json()
    expect(await undo(second)).toMatchObject({ undo: { status: 'applied' } })
    expect(queries.threadSummary(threadId)?.bucket?.bucket).toBe('Later')
    expect(await undo(first)).toMatchObject({ undo: { status: 'applied' } })
    expect(queries.threadSummary(threadId)?.bucket).toBeNull()
    expect(correctionExamples(db, 'a')).toEqual([])
    expect(
      db.prepare('SELECT action_id FROM owner_handled WHERE thread_id = ?').get(threadId),
    ).toMatchObject({ action_id: 'reply:outbox' })
    put('a', 'new', 'person@example.test', 30, 'in')
    markConfirmedReply(store, reply, 'out@example.test', receipt)
    expect(threadInput(db, threadId)).toMatchObject({ handled_id: 'a:in', input_id: 'a:new' })
  } finally {
    db.close()
  }
})
