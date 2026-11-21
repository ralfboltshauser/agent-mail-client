import { type AgentAction, SCOPES, type Scope } from '@amc/protocol'
import { Client } from '@modelcontextprotocol/sdk/client/index.js'
import { InMemoryTransport } from '@modelcontextprotocol/sdk/inMemory.js'
import { describe, expect, it, vi } from 'vitest'
import { authenticate, DAY_MS, issueToken, revokeToken } from '../auth/tokens.ts'
import { BlobStore } from '../blobs.ts'
import { createApp } from '../http/app.ts'
import { listAgentActions } from '../mail/agent-actions.ts'
import { Drafts } from '../mail/drafts.ts'
import { Mutations } from '../mail/mutations.ts'
import { MailQueries } from '../mail/queries.ts'
import { MailStore } from '../mail/store.ts'
import { FakeGmail } from '../providers/gmail/fake.ts'
import { fromGmail } from '../providers/gmail/mapping.ts'
import { toIncomingLabel } from '../providers/gmail/sync.ts'
import { silentLog, tempDir, testConfig, testDb } from '../test-support.ts'
import { buildMcpServer } from './server.ts'

function setup() {
  const db = testDb()
  db.prepare(
    "INSERT INTO account (id, kind, address, credentials, created_at) VALUES ('a', 'gmail', 'owner@example.com', x'00', 0)",
  ).run()
  const store = new MailStore(db, new BlobStore(tempDir()))
  const gmail = new FakeGmail()
  const incoming = gmail.add('m1', {
    subject: 'Dinner?',
    from: 'Alice <alice@example.com>',
    body: 'Friday works?',
  })
  store.putMessage('a', ['owner@example.com'], fromGmail(incoming))
  const drafts = new Drafts(db, store, () => gmail)
  const mutations = new Mutations(store, () => gmail, silentLog)
  return { db, store, gmail, drafts, mutations, queries: new MailQueries(db) }
}

async function connect(scopes: Scope[], deps = setup(), accountId?: string) {
  const token = issueToken(deps.db, {
    kind: 'agent',
    name: 't3',
    scopes: scopes.filter((scope) => scope !== 'admin' && scope !== 'send'),
    expiresAt: Date.now() + DAY_MS,
    ...(accountId ? { accountId } : {}),
  })
  const principal = authenticate(deps.db, token.secret)
  if (!principal) throw new Error('Fixture token rejected')
  const server = buildMcpServer({ ...principal, scopes }, deps)
  const [a, b] = InMemoryTransport.createLinkedPair()
  const client = new Client({ name: 'test', version: '0' })
  await Promise.all([server.connect(a), client.connect(b)])
  return { client, token, ...deps }
}

function combinations<T>(items: readonly T[]): T[][] {
  const all: T[][] = [[]]
  for (const item of items) {
    for (const combo of [...all]) all.push([...combo, item])
  }
  return all
}

const organizeTools = [
  'set_bucket',
  'archive',
  'mark_read',
  'mark_unread',
  'star',
  'unstar',
  'add_label',
  'remove_label',
  'mute',
  'organize_status',
]

const text = (result: unknown) => (result as { content: { text: string }[] }).content[0]?.text ?? ''

describe('MCP tools', () => {
  it('never exposes a way to send, for any combination of scopes (ADR 0001)', async () => {
    for (const scopes of combinations(SCOPES)) {
      const { client } = await connect(scopes)
      const { tools } = await client.listTools()
      expect(tools.map(({ name }) => name).filter((name) => organizeTools.includes(name))).toEqual(
        scopes.includes('organize') ? organizeTools : [],
      )
      for (const name of ['get_message', 'list_untriaged']) {
        expect(tools.some((tool) => tool.name === name)).toBe(scopes.includes('read'))
        if (!scopes.includes('read'))
          expect(await client.callTool({ name, arguments: {} })).toMatchObject({ isError: true })
      }
      for (const name of ['send', 'send_draft', 'trash', 'snooze']) {
        const reply = await client.callTool({ name, arguments: { thread_ids: ['a:t-m1'] } })
        expect(reply).toMatchObject({ isError: true })
      }
      for (const tool of tools) {
        expect(tool.name).not.toMatch(/send|deliver|submit|dispatch/i)
        expect(`${tool.description}`).not.toMatch(/\bsends? (the|an|a) (mail|email|message)\b/i)
      }
    }
  })

  it('exposes only the tools a token is scoped for', async () => {
    const none = await connect([])
    expect((await none.client.listTools()).tools.map((t) => t.name)).toEqual(['whoami'])
    const read = await connect(['read'])
    const readTools = (await read.client.listTools()).tools.map((t) => t.name)
    expect(readTools).toContain('get_thread')
    expect(readTools).toContain('get_message')
    expect(readTools).not.toContain('create_draft')
    expect(readTools).not.toContain('set_bucket')
    expect(readTools).toContain('list_untriaged')
    const draft = await connect(['read', 'draft'])
    expect((await draft.client.listTools()).tools.map((t) => t.name)).toContain('create_draft')
  })

  it('lists only Inbox Threads without a Bucket and attributes assignments to the Agent', async () => {
    const { client, db, queries, gmail, store, mutations } = await connect(
      ['read', 'organize'],
      setup(),
      'a',
    )
    db.exec(
      "INSERT INTO account (id, kind, address, credentials, created_at) VALUES ('b', 'gmail', 'other@example.com', x'00', 0)",
    )
    store.putMessage(
      'b',
      ['other@example.com'],
      fromGmail(gmail.add('other', { date: Date.now() + DAY_MS })),
    )
    const archived = gmail.add('archived', { labels: ['STARRED'] })
    store.putMessage('a', ['owner@example.com'], fromGmail(archived))
    const list = async () =>
      JSON.parse(
        text(
          await client.callTool({
            name: 'list_untriaged',
            arguments: { limit: 1 },
          }),
        ),
      )
    const input = { threadId: 'a:t-m1', bucket: 'Reply', reason: 'Alice asked a question' }
    const set = (args = input) => client.callTool({ name: 'set_bucket', arguments: args })
    expect(await list()).toMatchObject([{ id: input.threadId }])
    expect(
      await client.callTool({ name: 'list_untriaged', arguments: { account_id: 'b' } }),
    ).toMatchObject({ isError: true })
    expect(await set({ ...input, threadId: 'b:t-other' })).toMatchObject({ isError: true })
    expect(queries.threadSummary('b:t-other')?.bucket).toBeNull()
    expect(await set()).not.toHaveProperty('isError', true)
    expect(listAgentActions(db, mutations).actions[0]).toMatchObject({
      tool: 'set_bucket',
      tokenName: 't3',
      threads: [input.threadId],
      status: 'applied',
    })
    expect(queries.threadSummary(input.threadId)?.bucket).toEqual({
      bucket: 'Reply',
      reason: input.reason,
      setBy: 't3',
      setAt: expect.any(Number),
    })
    expect(await list()).toEqual([])
    const skipped = await client.callTool({
      name: 'set_bucket',
      arguments: { ...input, bucket: 'Later', onlyUntriaged: true },
    })
    expect(JSON.parse(text(skipped))).toEqual({ updated: false })
    expect(queries.threadSummary(input.threadId)?.bucket?.bucket).toBe('Reply')
  })

  it('refuses Bucket Undo and keeps a newer owner assignment', async () => {
    const { client, db, store, mutations, queries } = await connect(['organize'])
    const threadId = 'a:t-m1'
    const assignment = await client.callTool({
      name: 'set_bucket',
      arguments: { threadId, bucket: 'Reply', reason: 'Agent assignment' },
    })
    expect(assignment).not.toHaveProperty('isError', true)
    const [action] = listAgentActions(db, mutations).actions
    if (!action) throw new Error('Missing agent action')
    const revised = { threadId, bucket: 'Later', reason: 'Owner correction' } as const
    expect(store.setBucket(revised, 'owner')).toBe(true)

    const app = createApp({ db, config: testConfig(), log: silentLog, mutations })
    const owner = issueToken(db, { kind: 'cli', name: 'Owner', scopes: ['admin', 'organize'] })
    const response = await app.request(`/v1/agent/log/${action.id}/undo`, {
      method: 'POST',
      headers: { Authorization: `Bearer ${owner.secret}` },
    })
    expect(response.status).toBe(409)
    expect(await response.json()).toMatchObject({
      message: 'Bucket Undo is unavailable because its previous assignment was not recorded',
    })
    expect(queries.threadSummary(threadId)?.bucket).toMatchObject({
      bucket: revised.bucket,
      reason: revised.reason,
      setBy: 'owner',
    })
    await client.close()
  })

  it('reads a Thread and drafts a threaded reply that lands in Gmail', async () => {
    const { client, db, gmail, mutations } = await connect(['read', 'draft'])
    const thread = JSON.parse(
      text(await client.callTool({ name: 'get_thread', arguments: { thread_id: 'a:t-m1' } })),
    )
    expect(thread.messages[0].bodyText).toBe('Friday works?')

    const draft = JSON.parse(
      text(
        await client.callTool({
          name: 'create_draft',
          arguments: { thread_id: 'a:t-m1', body: 'Friday is great.' },
        }),
      ),
    )
    expect(draft).toMatchObject({
      subject: 'Re: Dinner?',
      lastAuthor: 't3',
      to: [{ address: 'alice@example.com' }],
    })
    const saved = [...gmail.drafts.values()][0]
    expect(saved?.threadId).toBe('t-m1')
    expect(saved?.raw).toContain('In-Reply-To: <m1@example.com>')

    const updated = JSON.parse(
      text(
        await client.callTool({
          name: 'update_draft',
          arguments: { draft_id: draft.id, body: 'Friday at 7?', revision: draft.revision },
        }),
      ),
    )
    expect(updated.body).toBe('Friday at 7?')
    expect(gmail.drafts.size).toBe(1)
    const { actions } = listAgentActions(db, mutations)
    expect(actions).toMatchObject([
      { tool: 'update_draft', status: 'applied', draftId: draft.id, threads: ['a:t-m1'] },
      { tool: 'create_draft', status: 'applied', draftId: draft.id, threads: ['a:t-m1'] },
    ])
    expect(JSON.stringify(actions)).not.toContain('Friday at 7?')
  })

  it('shows a local draft save and clears its mirror error after a successful retry', async () => {
    const { client, db, drafts, gmail, mutations } = await connect(['draft'])
    vi.spyOn(gmail, 'saveDraft').mockRejectedValueOnce(new Error('Provider unavailable'))
    try {
      const response = await client.callTool({
        name: 'create_draft',
        arguments: { thread_id: 'a:t-m1', body: 'Saved locally' },
      })
      expect(response.isError).toBeFalsy()
      const { id } = JSON.parse(text(response))
      const activity = () => listAgentActions(db, mutations).actions[0]
      expect(activity()).toMatchObject({
        draftId: id,
        status: 'applied',
        error: 'Draft saved locally. Mirroring to the provider failed and will retry.',
      })
      expect(gmail.drafts.size).toBe(0)

      await drafts.mirrorPending()
      expect(gmail.drafts.size).toBe(1)
      expect(activity()).toMatchObject({ draftId: id, status: 'applied', error: null })
    } finally {
      await client.close()
      db.close()
    }
  })

  it('uses the draft’s current From Account even when it is still linked to the original Thread', async () => {
    const deps = setup()
    const { db, drafts } = deps
    db.prepare(
      "INSERT INTO account (id, kind, address, credentials, created_at) VALUES ('b', 'gmail', 'other@example.com', x'00', 0)",
    ).run()
    const draft = await drafts.create({ threadId: 'a:t-m1', body: 'Private draft' }, 'owner')
    const a = await connect(['read', 'draft'], deps, 'a')
    const b = await connect(['read', 'draft'], deps, 'b')
    const thread = () =>
      a.client.callTool({ name: 'get_thread', arguments: { thread_id: 'a:t-m1' } })
    expect(JSON.parse(text(await thread())).drafts).toMatchObject([{ id: draft.id }])

    const compose = drafts.compose(draft.id)
    if (!compose) throw new Error('Missing draft')
    drafts.saveCompose(draft.id, {
      baseRevision: compose.revision,
      update: compose.update,
      fields: {
        accountId: 'b',
        to: compose.to,
        cc: compose.cc,
        bcc: compose.bcc,
        subject: compose.subject,
        attachmentIds: [],
      },
    })
    expect(JSON.parse(text(await thread())).drafts).toEqual([])
    const list = (client: Client) =>
      client.callTool({ name: 'list_drafts', arguments: { thread_id: 'a:t-m1' } })
    expect(JSON.parse(text(await list(a.client)))).toEqual([])
    expect(JSON.parse(text(await list(b.client)))).toMatchObject([{ id: draft.id }])
    const read = (client: Client) =>
      client.callTool({ name: 'read_draft', arguments: { draft_id: draft.id } })
    expect(await read(a.client)).toMatchObject({ isError: true })
    expect(JSON.parse(text(await read(b.client)))).toMatchObject({
      accountId: 'b',
      threadId: 'a:t-m1',
      body: 'Private draft',
    })
    expect(
      await a.client.callTool({
        name: 'update_draft',
        arguments: { draft_id: draft.id, body: 'Out of bounds' },
      }),
    ).toMatchObject({ isError: true })
    expect(drafts.get(draft.id)?.body).toBe('Private draft')
  })

  it('returns receipts for draft-only writes and limits edits to drafts created by that grant', async () => {
    const deps = setup()
    const { db, drafts, client, token } = await connect(['draft'], deps, 'a')
    const other = await connect(['draft'], deps, 'a')
    const ownerDraft = await drafts.create({ threadId: 'a:t-m1', body: 'Owner content' }, 'owner')
    const app = createApp({ db, config: testConfig(), log: silentLog, mail: deps as never })
    const receipt = (id: string) => ({
      id,
      revision: drafts.compose(id)?.revision,
      status: 'applied',
    })
    const create = await client.callTool({
      name: 'create_draft',
      arguments: { thread_id: 'a:t-m1', body: 'Agent content' },
    })
    const draft = JSON.parse(text(create))
    expect(draft).toEqual(receipt(draft.id))
    expect(drafts.get(draft.id)).toMatchObject({
      subject: 'Re: Dinner?',
      to: [{ address: 'alice@example.com' }],
    })
    await drafts.update(draft.id, { body: 'Owner edit', subject: 'Owner subject' }, 'owner')
    const edit = (client: Client, id: string) =>
      client.callTool({ name: 'update_draft', arguments: { draft_id: id, cc: [] } })
    expect(await edit(client, ownerDraft.id)).toMatchObject({ isError: true })
    expect(await edit(other.client, draft.id)).toMatchObject({ isError: true })
    expect(
      await client.callTool({ name: 'read_draft', arguments: { draft_id: draft.id } }),
    ).toMatchObject({
      isError: true,
    })
    expect(JSON.parse(text(await edit(client, draft.id)))).toEqual(receipt(draft.id))
    expect(drafts.get(draft.id)?.body).toBe('Owner edit')

    const response = await app.request('/v1/drafts', {
      method: 'POST',
      headers: { Authorization: `Bearer ${token.secret}`, 'Content-Type': 'application/json' },
      body: JSON.stringify({ threadId: 'a:t-m1', body: 'HTTP reply' }),
    })
    expect(response.status).toBe(200)
    const httpDraft = (await response.json()) as { id: string }
    expect(httpDraft).toEqual(receipt(httpDraft.id))
    expect(JSON.parse(text(await edit(client, httpDraft.id)))).toEqual(receipt(httpDraft.id))
  })

  it('budgets text newest first and reads omitted messages within the token account', async () => {
    const deps = setup()
    deps.db
      .prepare(
        "INSERT INTO account (id, kind, address, credentials, created_at) VALUES ('b', 'gmail', 'other@example.com', x'00', 0)",
      )
      .run()
    const { client, store, gmail } = await connect(['read'], deps, 'a')
    const largeBody = 'x'.repeat(20_000)
    const now = Date.now()
    for (let n = 2; n <= 9; n++) {
      store.putMessage(
        'a',
        ['owner@example.com'],
        fromGmail(
          gmail.add(`m${n}`, {
            threadId: 't-m1',
            labels: ['INBOX'],
            date: n * 1000 + now,
            body: n === 9 ? 'Newest reply' : n === 3 ? '' : `${n}${largeBody}`,
          }),
        ),
      )
    }
    const thread = JSON.parse(
      text(await client.callTool({ name: 'get_thread', arguments: { thread_id: 'a:t-m1' } })),
    )
    expect(thread.messages.map((m: { id: string }) => m.id)).toEqual(
      Array.from({ length: 9 }, (_, i) => `a:m${i + 1}`),
    )
    const marker = '\n[…truncated]'
    expect(thread.messages.map((m: { bodyText: string }) => m.bodyText)).toEqual([
      marker,
      marker,
      '',
      `4${largeBody.slice(0, -1 - 'Newest reply'.length)}${marker}`,
      ...[5, 6, 7, 8].map((n) => `${n}${largeBody.slice(1)}${marker}`),
      'Newest reply',
    ])

    const args = { name: 'get_message', arguments: { messageId: 'a:m2' } }
    expect(JSON.parse(text(await client.callTool(args)))).toMatchObject({
      id: 'a:m2',
      bodyText: `2${largeBody.slice(1)}${marker}`,
    })
    const other = await connect(['read'], deps, 'b')
    expect(await other.client.callTool(args)).toMatchObject({ isError: true })
  })

  it('searches mail and contacts', async () => {
    const { client } = await connect(['read'])
    expect(
      JSON.parse(text(await client.callTool({ name: 'search', arguments: { query: 'friday' } }))),
    ).toHaveLength(1)
    const contacts = JSON.parse(
      text(await client.callTool({ name: 'search_contacts', arguments: { query: 'ali' } })),
    )
    expect(contacts[0].address).toBe('alice@example.com')
  })

  it('writes every organize tool through M3 and returns per-message outcomes', async () => {
    const { client, db, store, gmail, mutations } = await connect(['organize'])
    vi.spyOn(mutations, 'kick').mockImplementation(() => {})
    gmail.labelList.push({ id: 'Label_1', name: 'Follow up', type: 'user' })
    store.syncLabels('a', gmail.labelList.map(toIncomingLabel))
    const steps = [
      ['mark_unread', 'UNREAD', true],
      ['mark_read', 'UNREAD', false],
      ['star', 'STARRED', true],
      ['unstar', 'STARRED', false],
      ['add_label', 'Label_1', true],
      ['remove_label', 'Label_1', false],
      ['archive', 'INBOX', false],
      ['mute', 'INBOX', false],
    ] as const
    for (const [name, label, present] of steps) {
      const pending: AgentAction = JSON.parse(
        text(
          await client.callTool({
            name,
            arguments: {
              thread_ids: ['a:t-m1'],
              ...(label === 'Label_1' ? { label_id: 'a:Label_1' } : {}),
            },
          }),
        ),
      )
      expect(pending).toMatchObject({
        tokenName: 't3',
        tool: name,
        threads: ['a:t-m1'],
        status: 'pending',
        mutations: [{ messages: [{ messageId: 'a:m1', status: 'pending' }] }],
      })
      await mutations.tick()
      const settled = JSON.parse(
        text(
          await client.callTool({
            name: 'organize_status',
            arguments: { action_id: pending.id },
          }),
        ),
      )
      expect(settled).toMatchObject({
        status: 'applied',
        mutations: [{ messages: [{ messageId: 'a:m1' }] }],
      })
      expect((await gmail.getMessageLabels('m1'))?.includes(label)).toBe(present)
    }
    expect(listAgentActions(db, mutations).actions).toHaveLength(8)
  })

  it('denies an entire mixed-Account batch and keeps reads and drafts scoped', async () => {
    const deps = setup()
    const { db, store, gmail, mutations } = deps
    db.prepare(
      "INSERT INTO account (id, kind, address, credentials, created_at) VALUES ('b', 'gmail', 'other@example.com', x'00', 0)",
    ).run()
    store.putMessage(
      'b',
      ['other@example.com'],
      fromGmail(gmail.add('m2', { subject: 'Dinner?', body: 'Friday' })),
    )
    const { client, token } = await connect(['read', 'organize', 'draft'], deps, 'a')
    const call = (name: string, args: Record<string, unknown>) =>
      client.callTool({ name, arguments: args })
    expect(await call('archive', { thread_ids: ['a:t-m1', 'b:t-m2'] })).toMatchObject({
      isError: true,
    })
    expect(db.prepare('SELECT count(*) AS count FROM mutation').get()?.count).toBe(0)
    expect(await call('get_thread', { thread_id: 'b:t-m2' })).toMatchObject({ isError: true })
    expect(
      JSON.parse(text(await call('search', { account_id: 'b', query: 'Friday' }))),
    ).toMatchObject([{ accountId: 'a' }])
    expect(
      await call('create_draft', { thread_id: 'b:t-m2', account_id: 'a', body: 'Synthetic' }),
    ).toMatchObject({ isError: true })
    expect(gmail.drafts.size).toBe(0)
    const app = createApp({ db, config: testConfig(), log: silentLog, mutations })
    expect(
      (await app.request('/v1/agent/log', { headers: { Authorization: `Bearer ${token.secret}` } }))
        .status,
    ).toBe(403)
    expect(listAgentActions(db, mutations).actions.map(({ status }) => status)).toEqual([
      'failed',
      'rejected',
    ])
  })

  it('audits the per-token cap and rechecks revocation before queued writeback', async () => {
    const { client, token, gmail, mutations, db } = await connect(['organize'])
    vi.spyOn(mutations, 'kick').mockImplementation(() => {})
    vi.spyOn(Date, 'now').mockReturnValue(Math.floor(Date.now() / 60_000) * 60_000)
    try {
      db.prepare('UPDATE token SET mutation_minute = ?, mutation_count = 59 WHERE id = ?').run(
        Math.floor(Date.now() / 60_000),
        token.id,
      )
      const invoke = () =>
        client.callTool({ name: 'archive', arguments: { thread_ids: ['a:t-m1'] } })
      expect(JSON.parse(text(await invoke())).status).toBe('pending')
      const blocked = await invoke()
      expect(blocked).toMatchObject({ isError: true })
      expect(text(blocked)).toMatch(/retry in 60s/)
      revokeToken(db, token.id)
      await mutations.tick()
      expect(await gmail.getMessageLabels('m1')).toContain('INBOX')
      expect(listAgentActions(db, mutations).actions.map(({ status }) => status)).toEqual([
        'rejected',
        'failed',
      ])
    } finally {
      vi.restoreAllMocks()
    }
  })

  it('lets the owner undo an exact logged action even after a newer action on that Thread', async () => {
    const { db, client, gmail, mutations } = await connect(['organize'])
    vi.spyOn(mutations, 'kick').mockImplementation(() => {})
    const write = async (name: string): Promise<AgentAction> => {
      const action = JSON.parse(
        text(await client.callTool({ name, arguments: { thread_ids: ['a:t-m1'] } })),
      )
      await mutations.tick()
      return action
    }
    const archive = await write('archive')
    await write('star')
    const app = createApp({ db, config: testConfig(), log: silentLog, mutations })
    const owner = issueToken(db, { kind: 'cli', name: 'owner', scopes: ['admin', 'organize'] })
    const headers = { Authorization: `Bearer ${owner.secret}` }
    const before = await app.request('/v1/agent/log', { headers })
    expect(before.status).toBe(200)
    expect(await before.json()).toMatchObject({
      actions: [{ tool: 'star' }, { id: archive.id, status: 'applied' }],
    })
    const undo = () => app.request(`/v1/agent/log/${archive.id}/undo`, { method: 'POST', headers })
    const result = await undo()
    expect(result.status).toBe(200)
    const first = await result.json()
    expect(await (await undo()).json()).toEqual(first)
    await mutations.tick()
    expect(await gmail.getMessageLabels('m1')).toEqual(expect.arrayContaining(['INBOX', 'STARRED']))
    expect(await (await app.request('/v1/agent/log', { headers })).json()).toMatchObject({
      actions: [{ tool: 'star' }, { mutations: [{ undo: { status: 'applied' } }] }],
    })
  })
})
