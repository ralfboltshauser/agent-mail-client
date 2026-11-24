import { execFile } from 'node:child_process'
import { randomBytes, randomUUID } from 'node:crypto'
import { once } from 'node:events'
import { rm } from 'node:fs/promises'
import { fileURLToPath } from 'node:url'
import { isCorrelationId, newRequestId, REQUEST_ID_HEADER } from '@amc/observability'
import {
  type AgentAction,
  MCP_CLI_AGENT_PATH,
  MCP_CLI_OWNER_PATH,
  SCOPES,
  type Scope,
} from '@amc/protocol'
import { serve } from '@hono/node-server'
import { Client } from '@modelcontextprotocol/sdk/client/index.js'
import { InMemoryTransport } from '@modelcontextprotocol/sdk/inMemory.js'
import { describe, expect, it, vi } from 'vitest'
import { startHandoff } from '../auth/handoff.ts'
import { authenticate, DAY_MS, issueToken, revokeToken } from '../auth/tokens.ts'
import { BlobStore } from '../blobs.ts'
import { Sealer } from '../crypto.ts'
import { createApp } from '../http/app.ts'
import { listAgentActions } from '../mail/agent-actions.ts'
import { Drafts } from '../mail/drafts.ts'
import { Mutations } from '../mail/mutations.ts'
import { MailQueries } from '../mail/queries.ts'
import { MailStore } from '../mail/store.ts'
import { FakeGmail } from '../providers/gmail/fake.ts'
import { fromGmail } from '../providers/gmail/mapping.ts'
import { toIncomingLabel } from '../providers/gmail/sync.ts'
import { parseMessage } from '../providers/imap/mapping.ts'
import { SyncManager } from '../sync/manager.ts'
import { silentLog, tempDir, testConfig, testDb } from '../test-support.ts'
import { buildMcpServer } from './server.ts'

function setup() {
  const db = testDb()
  db.prepare(
    "INSERT INTO account (id, kind, address, credentials, created_at) VALUES ('a', 'gmail', 'owner@example.com', x'00', 0)",
  ).run()
  const blobs = new BlobStore(tempDir())
  const store = new MailStore(db, blobs)
  const gmail = new FakeGmail()
  const incoming = gmail.add('m1', {
    subject: 'Dinner?',
    from: 'Alice <alice@example.com>',
    body: 'Friday works?',
  })
  store.putMessage('a', ['owner@example.com'], fromGmail(incoming))
  const drafts = new Drafts(db, store, () => gmail)
  const mutations = new Mutations(store, () => gmail, silentLog)
  return { db, store, blobs, gmail, drafts, mutations, queries: new MailQueries(db) }
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
  'set_bucket_by_id',
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

it('maps every MCP tool to a CLI command or the triage runner', async () => {
  const deps = setup()
  const { db } = deps
  const holder = `triage-${randomUUID()}`
  const expiresAt = Date.now() + 60_000
  db.prepare('INSERT INTO triage_lease (slot, holder, expires_at) VALUES (1, ?, ?)').run(
    holder,
    expiresAt,
  )
  const tokens = [
    issueToken(db, { kind: 'cli', name: 'local', scopes: ['read', 'organize', 'draft'] }),
    issueToken(db, {
      kind: 'agent',
      name: 'general',
      scopes: ['read', 'organize', 'draft'],
      expiresAt,
    }),
    issueToken(db, {
      kind: 'agent',
      name: holder,
      scopes: ['read', 'organize'],
      accountId: 'a',
      expiresAt,
    }),
  ]
  const coverage = {
    whoami: 'whoami',
    list_accounts: 'accounts',
    list_threads: 'threads',
    get_thread: 'thread',
    get_message: 'message',
    search: 'search',
    search_contacts: 'contacts',
    list_labels: 'labels',
    list_buckets: 'buckets list',
    list_untriaged: 'triage untriaged',
    list_drafts: 'draft list',
    read_draft: 'draft show',
    create_draft: 'draft create or reply',
    update_draft: 'draft update',
    delete_draft: 'draft discard',
    archive: 'archive',
    mark_read: 'read',
    mark_unread: 'unread',
    star: 'star',
    unstar: 'star --remove',
    mute: 'mute',
    add_label: 'label',
    remove_label: 'label --remove',
    organize_status: 'agent status',
    set_bucket: 'bucket',
    set_bucket_by_id: 'bucket <thread> <id>',
    suggest_sender_rule: 'senders suggest',
    submit_triage_prediction: 'internal to triage runner',
  }
  const discovered = new Set<string>()
  try {
    for (const token of tokens) {
      const principal = authenticate(db, token.secret)
      if (!principal) throw new Error('Fixture token rejected')
      const server = buildMcpServer(principal, deps)
      const [a, b] = InMemoryTransport.createLinkedPair()
      const client = new Client({ name: 'test', version: '0' })
      await Promise.all([server.connect(a), client.connect(b)])
      try {
        for (const { name } of (await client.listTools()).tools) discovered.add(name)
      } finally {
        await client.close()
      }
    }
    expect([...discovered].sort()).toEqual(Object.keys(coverage).sort())
  } finally {
    db.close()
  }
})

it('drives drafts and organize through the CLI with paired, scoped and handoff credentials', async () => {
  const deps = setup()
  const { db, drafts, gmail, mutations, store } = deps
  db.exec(
    "INSERT INTO account (id, kind, address, credentials, created_at) VALUES ('b', 'gmail', 'other@example.com', x'00', 0)",
  )
  store.putMessage('a', [], fromGmail(gmail.add('m2')))
  store.putMessage('b', [], fromGmail(gmail.add('outside')))
  const owner = issueToken(db, {
    kind: 'cli',
    name: 'mac',
    scopes: ['read', 'organize', 'draft', 'admin'],
  })
  const agent = (scopes: Scope[]) =>
    issueToken(db, {
      kind: 'agent',
      name: 'shell-agent',
      scopes,
      accountId: 'a',
      expiresAt: Date.now() + DAY_MS,
    })
  const scoped = agent(['read', 'organize', 'draft'])
  const draftOnly = agent(['draft'])
  const handoff = await startHandoff(db, drafts, 'a:t-m2', randomUUID())
  const sealer = new Sealer(randomBytes(32))
  const oauthClient = () => ({ clientId: 'synthetic', clientSecret: 'synthetic' })
  const sync = new SyncManager({
    db,
    store,
    sealer,
    oauthClient,
    log: silentLog,
    gmailApi: () => gmail,
  })
  const app = createApp({
    db,
    config: testConfig(),
    log: silentLog,
    mutations,
    mail: { ...deps, sealer, oauthClient, sync, log: silentLog },
  })
  const home = tempDir()
  let oldEngine: 'always' | 'on-write' | undefined
  let draftResponseFault:
    | {
        tool: 'create_draft' | 'update_draft' | 'delete_draft'
        response: 'lost' | Record<string, unknown>
      }
    | undefined
  vi.spyOn(mutations, 'kick').mockImplementation(() => {})
  const listener = serve({
    fetch: async (req) => {
      const rpc =
        req.method === 'POST' && (oldEngine || draftResponseFault)
          ? ((await req.clone().json()) as { method: string; params?: { name?: string } })
          : null
      const path = new URL(req.url).pathname
      const cliRoute = path === MCP_CLI_OWNER_PATH || path === MCP_CLI_AGENT_PATH
      if (
        cliRoute &&
        (oldEngine === 'always' || (oldEngine === 'on-write' && rpc?.method === 'tools/call'))
      )
        return new Response(null, { status: 404 })
      const response = await app.fetch(req)
      if (
        draftResponseFault &&
        rpc?.method === 'tools/call' &&
        rpc.params?.name === draftResponseFault.tool
      ) {
        if (draftResponseFault.response === 'lost') return new Response(null, { status: 502 })
        const payload = (await response.json()) as {
          result: { content: { type: string; text: string }[] }
        }
        payload.result.content = [
          { type: 'text', text: JSON.stringify(draftResponseFault.response) },
        ]
        return Response.json(payload)
      }
      return response
    },
    hostname: '127.0.0.1',
    port: 0,
  })
  const send = vi.spyOn(gmail, 'sendMessage')
  try {
    await once(listener, 'listening')
    const address = listener.address()
    if (!address || typeof address === 'string') throw new Error('Expected a TCP address')
    const cli = (secret: string, args: string[], input?: string) =>
      new Promise<{ code: number; stdout: string; stderr: string }>((resolve) => {
        const processHandle = execFile(
          process.execPath,
          [fileURLToPath(new URL('../../../cli/src/main.ts', import.meta.url)), ...args],
          {
            env: {
              ...process.env,
              AMC_ENGINE_URL: `http://127.0.0.1:${address.port}`,
              AMC_TOKEN: secret,
              AMC_DEBUG: '0',
              XDG_STATE_HOME: home,
              XDG_CONFIG_HOME: home,
              HOME: home,
            },
            timeout: 5000,
          },
          (error, stdout, stderr) =>
            resolve({ code: error ? Number(error.code) : 0, stdout, stderr }),
        )
        processHandle.stdin?.end(input)
      })
    const custom = await cli(owner.secret, [
      'buckets',
      'create',
      'Receipts',
      '--description',
      'Order receipts',
      '--auto',
      '--json',
    ])
    expect(custom).toMatchObject({ code: 0, stderr: '' })
    const bucketId = JSON.parse(custom.stdout).definition.id
    const discovered = await cli(scoped.secret, ['--as-agent', 'buckets', 'list', '--json'])
    expect(discovered).toMatchObject({ code: 0, stderr: '' })
    expect(JSON.parse(discovered.stdout).definitions).toContainEqual({
      id: bucketId,
      name: 'Receipts',
    })
    const assignment = await cli(scoped.secret, [
      '--as-agent',
      'bucket',
      'a:t-m2',
      bucketId,
      '--json',
    ])
    expect(assignment).toMatchObject({ code: 0, stderr: '' })
    expect(JSON.parse(assignment.stdout)).toEqual({ updated: true })
    const updated = await cli(owner.secret, [
      'buckets',
      'edit',
      bucketId,
      '--name',
      'Purchases',
      '--json',
    ])
    expect(updated).toMatchObject({ code: 0, stderr: '' })
    expect(JSON.parse(updated.stdout).definitions).toContainEqual(
      expect.objectContaining({ id: bucketId, name: 'Purchases', automatic: true }),
    )
    expect(deps.queries.threadSummary('a:t-m2')?.bucketAssignment?.bucketId).toBe(bucketId)
    const draftReply = ['reply', 'a:t-m1', '--body-file', '-', '--json']
    const scopedReply = await cli(
      scoped.secret,
      ['--as-agent', ...draftReply],
      'A synthetic reply.\n',
    )
    expect(scopedReply).toMatchObject({ code: 0, stderr: '' })
    const reply = JSON.parse(scopedReply.stdout)
    expect(reply).toMatchObject({
      subject: 'Re: Dinner?',
      lastAuthor: 'shell-agent',
      mirrorStatus: 'mirrored',
      body: 'A synthetic reply.\n',
      to: [{ address: 'alice@example.com' }],
    })
    expect(
      [...gmail.drafts.values()].some(({ raw }) => raw.includes('In-Reply-To: <m1@example.com>')),
    ).toBe(true)

    const ownerChange = await cli(owner.secret, [
      'draft',
      'update',
      reply.id,
      '--revision',
      String(reply.revision),
      '--subject',
      'Reviewed',
      '--json',
    ])
    expect(ownerChange).toMatchObject({ code: 0, stderr: '' })
    const stale = await cli(scoped.secret, [
      '--as-agent',
      'draft',
      'update',
      reply.id,
      '--revision',
      String(reply.revision),
      '--subject',
      'Stale',
    ])
    expect(stale).toMatchObject({ code: 1, stderr: expect.stringContaining('The draft changed') })
    expect(drafts.get(reply.id)?.subject).toBe('Reviewed')
    oldEngine = 'on-write'
    expect(
      await cli(owner.secret, [
        'draft',
        'update',
        reply.id,
        '--revision',
        String(reply.revision),
        '--subject',
        'Unchecked',
      ]),
    ).toMatchObject({ code: 1, stderr: expect.stringContaining('Engine version') })
    oldEngine = 'always'
    expect(
      await cli(scoped.secret, ['--as-agent', ...draftReply], 'Unsupported Engine'),
    ).toMatchObject({
      code: 1,
      stderr: expect.stringContaining('Engine version'),
    })
    expect(drafts.get(reply.id)?.subject).toBe('Reviewed')
    oldEngine = undefined

    const receipt = JSON.parse(
      (await cli(draftOnly.secret, ['--as-agent', ...draftReply], 'Draft only')).stdout,
    )
    expect(receipt).toEqual({
      id: expect.any(String),
      revision: expect.any(Number),
      status: 'applied',
      mirrorStatus: 'mirrored',
    })
    const show = await cli(draftOnly.secret, ['--as-agent', 'draft', 'show', receipt.id])
    expect(show).toMatchObject({ code: 1, stdout: '' })
    expect(await cli(owner.secret, ['--as-agent', ...draftReply], 'Must not save')).toMatchObject({
      code: 1,
      stdout: '',
      stderr: expect.stringContaining('requires a valid scoped token'),
    })
    expect(await cli('', ['--as-agent', ...draftReply])).toMatchObject({
      code: 1,
      stdout: '',
      stderr: expect.stringContaining('requires AMC_TOKEN'),
    })
    expect(
      await cli(handoff.agentToken, ['--as-agent', 'thread', 'a:t-m1', '--json']),
    ).toMatchObject({
      code: 1,
      stdout: '',
    })
    const current = JSON.parse(
      (await cli(handoff.agentToken, ['--as-agent', 'draft', 'show', handoff.draftId, '--json']))
        .stdout,
    )
    const changeHandoff = [
      '--as-agent',
      'draft',
      'update',
      handoff.draftId,
      '--revision',
      String(current.revision),
    ]
    expect(
      await cli(handoff.agentToken, [...changeHandoff, '--subject', 'Disallowed']),
    ).toMatchObject({ code: 1 })
    expect(
      await cli(handoff.agentToken, [...changeHandoff, '--body-file', '-'], 'Handoff body'),
    ).toMatchObject({ code: 0 })
    expect(drafts.get(handoff.draftId)?.body).toBe('Handoff body')
    expect(
      await cli(scoped.secret, [
        '--as-agent',
        'draft',
        'discard',
        reply.id,
        '--revision',
        String(reply.revision),
      ]),
    ).toMatchObject({ code: 1 })
    expect(
      await cli(owner.secret, ['draft', 'discard', reply.id, '--revision', String(reply.revision)]),
    ).toMatchObject({ code: 1 })
    expect(
      await cli(owner.secret, [
        'draft',
        'discard',
        reply.id,
        '--revision',
        String(JSON.parse(ownerChange.stdout).revision),
      ]),
    ).toMatchObject({ code: 0 })
    expect(drafts.get(reply.id)).toBeNull()

    expect(
      JSON.parse((await cli(scoped.secret, ['--as-agent', 'message', 'a:m1', '--json'])).stdout),
    ).toMatchObject({ id: 'a:m1', bodyText: 'Friday works?' })
    expect(
      JSON.parse(
        (await cli(scoped.secret, ['--as-agent', 'threads', '--all', '--account', 'b', '--json']))
          .stdout,
      ).threads.map(({ accountId }: { accountId: string }) => accountId),
    ).toEqual(['a', 'a'])
    const newDraft = JSON.parse(
      (
        await cli(
          scoped.secret,
          [
            '--as-agent',
            'draft',
            'create',
            '--to',
            'Reader <reader@example.com>',
            '--body-file',
            '-',
            '--json',
          ],
          'New synthetic note',
        )
      ).stdout,
    )
    expect(newDraft).toMatchObject({
      accountId: 'a',
      to: [{ name: 'Reader', address: 'reader@example.com' }],
    })
    for (const failure of ['lost', {}] as const) {
      draftResponseFault = { tool: 'create_draft', response: failure }
      const before = drafts.list().length
      expect(
        await cli(scoped.secret, ['--as-agent', ...draftReply], 'Saved before response failure'),
      ).toMatchObject({
        code: 1,
        stdout: '',
        stderr: expect.stringContaining('Check AMC before retrying'),
      })
      expect(drafts.list()).toHaveLength(before + 1)
    }
    const unconfirmed = {
      code: 1,
      stdout: '',
      stderr: expect.stringContaining('Check AMC before retrying'),
    }
    draftResponseFault = { tool: 'update_draft', response: { id: 'wrong-draft', revision: 1 } }
    expect(
      await cli(owner.secret, [
        'draft',
        'update',
        newDraft.id,
        '--revision',
        String(newDraft.revision),
        '--subject',
        'Changed',
      ]),
    ).toMatchObject(unconfirmed)
    const changed = drafts.get(newDraft.id)
    expect(changed?.subject).toBe('Changed')
    draftResponseFault = { tool: 'delete_draft', response: { absent: 'wrong-draft' } }
    expect(
      await cli(owner.secret, [
        'draft',
        'discard',
        newDraft.id,
        '--revision',
        String(changed?.revision),
      ]),
    ).toMatchObject(unconfirmed)
    expect(drafts.get(newDraft.id)).toBeNull()
    draftResponseFault = undefined

    const denied = await cli(scoped.secret, [
      '--as-agent',
      'star',
      'a:t-m1',
      '--thread',
      'b:t-outside',
      '--json',
    ])
    expect(denied).toMatchObject({ code: 1, stdout: '' })
    expect(await gmail.getMessageLabels('m1')).not.toContain('STARRED')
    const submitted = await cli(scoped.secret, [
      '--as-agent',
      'star',
      'a:t-m1',
      '--thread',
      'a:t-m2',
      '--json',
    ])
    expect(submitted).toMatchObject({ code: 0, stderr: '' })
    const action = JSON.parse(submitted.stdout)
    expect(action.status).toBe('pending')
    await mutations.tick()
    await mutations.tick()
    const result = await cli(scoped.secret, ['--as-agent', 'agent', 'status', action.id, '--json'])
    expect(result.code).toBe(0)
    expect(JSON.parse(result.stdout)).toMatchObject({
      status: 'applied',
      threads: ['a:t-m1', 'a:t-m2'],
    })
    expect(listAgentActions(db, mutations).actions).toEqual(
      expect.arrayContaining([
        expect.objectContaining({
          tool: 'update_draft',
          draftId: handoff.draftId,
          status: 'applied',
        }),
        expect.objectContaining({ tool: 'create_draft', draftId: receipt.id, status: 'applied' }),
      ]),
    )
    expect(send).not.toHaveBeenCalled()
  } finally {
    await new Promise<void>((resolve) => listener.close(() => resolve()))
    db.close()
    await rm(home, { recursive: true, force: true })
  }
}, 20_000)

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
        if (tool.name !== 'suggest_sender_rule')
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

  it('limits recent triage to provider delivery time across Gmail and IMAP', async () => {
    const { client, db, gmail, store } = await connect(['read'], setup())
    const now = Date.now()
    const old = now - 2 * DAY_MS
    const inbox = {
      path: 'INBOX',
      label: { providerId: 'INBOX', name: 'Inbox', kind: 'system' as const, color: null },
    }
    db.exec(
      "INSERT INTO account (id, kind, address, credentials, created_at) VALUES ('imap', 'imap', 'imap@example.com', x'00', 0)",
    )
    const putImap = async (
      thread: string,
      uid: number,
      dateHeader: number,
      internalDate: number,
    ) => {
      const source = store.blobs.put(
        `From: sender@example.com\r\nDate: ${new Date(dateHeader).toUTCString()}\r\nSubject: Message ${uid}\r\n\r\nBody`,
      )
      const msg = await parseMessage(
        inbox,
        '1',
        { seq: uid, uid, internalDate: new Date(internalDate) },
        store.blobs,
        source,
      )
      store.putMessage('imap', [], { ...msg, providerThreadId: thread })
    }

    await putImap('old', 1, now, old)
    await putImap('fresh', 2, old, now - 1_000)
    await putImap('fresh', 3, now, old)
    store.putMessage('a', [], fromGmail(gmail.add('recent', { date: now - 2_000 })))
    const unknown = gmail.add('unknown')
    delete unknown.internalDate
    unknown.payload?.headers?.push({ name: 'Date', value: new Date(now).toUTCString() })
    store.putMessage('a', [], fromGmail(unknown))

    const list = async (recent?: boolean) => {
      const result = await client.callTool({
        name: 'list_untriaged',
        arguments: { limit: 20, recent },
      })
      return (JSON.parse(text(result)) as { id: string }[]).map(({ id }) => id)
    }
    expect(await list(true)).toEqual(expect.arrayContaining(['a:t-recent', 'imap:fresh']))
    expect(await list(true)).toHaveLength(2)
    expect(await list()).toEqual(expect.arrayContaining(['a:t-m1', 'a:t-unknown', 'imap:old']))
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

  it('reports a later owner edit’s mirror failure as current draft status', async () => {
    const { client, db, drafts, gmail, mutations } = await connect(['draft'])
    try {
      const response = await client.callTool({
        name: 'create_draft',
        arguments: { thread_id: 'a:t-m1', body: 'Saved locally' },
      })
      expect(response.isError).toBeFalsy()
      const { id } = JSON.parse(text(response))
      const activity = () => listAgentActions(db, mutations).actions[0]
      expect(gmail.drafts.size).toBe(1)
      expect(activity()).not.toHaveProperty('currentDraftMirrorFailed')

      vi.spyOn(gmail, 'saveDraft').mockRejectedValueOnce(new Error('Provider unavailable'))
      await drafts.update(id, { body: 'Owner edit' }, 'owner')
      expect(activity()).toMatchObject({
        tool: 'create_draft',
        draftId: id,
        status: 'applied',
        error: null,
        currentDraftMirrorFailed: true,
      })

      await drafts.mirrorPending()
      expect(gmail.drafts.size).toBe(1)
      expect(activity()).not.toHaveProperty('currentDraftMirrorFailed')
    } finally {
      await client.close()
      db.close()
    }
  })

  it.each(['create', 'update'])(
    'returns the draft revision committed by %s during a concurrent edit',
    async (mode) => {
      const { db, drafts, gmail } = setup()
      let releaseMirror: (() => void) | undefined
      const paused = new Promise<void>((resolve) => {
        releaseMirror = resolve
      })
      try {
        const existing =
          mode === 'update'
            ? await drafts.create({ threadId: 'a:t-m1', body: 'Original' }, 'owner')
            : null
        const saveDraft = gmail.saveDraft.bind(gmail)
        const mirror = vi.spyOn(gmail, 'saveDraft').mockImplementationOnce(async (input) => {
          await paused
          return saveDraft(input)
        })
        const change = existing
          ? drafts.update(existing.id, { body: 'Agent text' }, 'agent', existing.revision)
          : drafts.create({ threadId: 'a:t-m1', body: 'Agent text' }, 'agent')
        await vi.waitFor(() => expect(mirror).toHaveBeenCalledOnce())
        const committed = drafts.list()[0]
        if (!committed) throw new Error('Expected the locally committed draft')
        const owner = drafts.update(
          committed.id,
          { body: 'Owner text' },
          'owner',
          committed.revision,
        )
        releaseMirror?.()
        const [receipt, latest] = await Promise.all([change, owner])
        expect(receipt).toMatchObject({
          id: committed.id,
          body: 'Agent text',
          revision: committed.revision,
        })
        expect(latest.body).toBe('Owner text')
        expect(latest.revision).toBeGreaterThan(receipt.revision)
        await expect(
          drafts.update(receipt.id, { subject: 'Stale change' }, 'agent', receipt.revision),
        ).rejects.toMatchObject({ status: 409, revision: latest.revision })
      } finally {
        releaseMirror?.()
        db.close()
      }
    },
  )

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

  it('pages directional search inside the read grant account', async () => {
    const deps = setup()
    deps.db.exec(`
      INSERT INTO account (id, kind, address, credentials, created_at)
      VALUES ('b', 'gmail', 'other@example.test', x'00', 0)
    `)
    for (const id of ['m2', 'm3']) deps.store.putMessage('a', [], fromGmail(deps.gmail.add(id)))
    deps.store.putMessage('b', [], fromGmail(deps.gmail.add('outside')))
    const { client } = await connect(['read'], deps, 'a')
    const search = async (offset: number) =>
      JSON.parse(
        text(
          await client.callTool({
            name: 'search',
            arguments: { query: 'from:alice@example.com', account_id: 'b', limit: 1, offset },
          }),
        ),
      )
    const first = await search(0)
    const second = await search(1)
    expect(first).toMatchObject([{ accountId: 'a' }])
    expect(second).toMatchObject([{ accountId: 'a' }])
    expect(first[0].id).not.toBe(second[0].id)
    await client.close()
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

it('records scoped Sender suggestions without giving the Agent authority to screen', async () => {
  const { client, db, token, gmail, store } = await connect(['read', 'organize'], setup(), 'a')
  const tool = (message_id = 'a:m1') =>
    client.callTool({
      name: 'suggest_sender_rule',
      arguments: { message_id, decision: 'block', reason: 'Owner review requested' },
    })
  const first = JSON.parse(text(await tool()))
  expect(first.actionId).toEqual(expect.any(String))
  expect(JSON.parse(text(await tool()))).toEqual(first)
  expect(db.prepare('SELECT decision, reason FROM sender_suggestion').all()).toEqual([
    { decision: 'block', reason: 'Owner review requested' },
  ])
  expect(
    db.prepare('SELECT tool FROM agent_action WHERE id = ?').get(first.actionId),
  ).toMatchObject({ tool: 'suggest_sender_rule' })
  expect(db.prepare('SELECT 1 FROM sender_rule').get()).toBeUndefined()
  expect(db.prepare('SELECT 1 FROM mutation').get()).toBeUndefined()
  db.exec(
    "INSERT INTO account (id, kind, address, credentials, created_at) VALUES ('b', 'gmail', 'other@example.com', X'00', 0)",
  )
  store.putMessage('b', [], fromGmail(gmail.add('other')))
  expect(await tool('b:other')).toMatchObject({ isError: true })

  db.exec(`
    INSERT INTO label (id, account_id, provider_id, name, kind) VALUES ('a:managed', 'a', 'managed', 'Screened out', 'user');
    INSERT INTO screened_destination (account_id, provider_id, state) VALUES ('a', 'managed', 'ready');
  `)
  expect(
    await client.callTool({
      name: 'add_label',
      arguments: { thread_ids: ['a:t-m1'], label_id: 'a:managed' },
    }),
  ).toMatchObject({ isError: true })
  expect(db.prepare('SELECT 1 FROM mutation').get()).toBeUndefined()
  revokeToken(db, token.id)
  expect(await tool()).toMatchObject({ isError: true })
})

it('requires both a paired owner kind and owner scope for Smart Inbox HTTP routes', async () => {
  const deps = setup()
  const { db, mutations } = deps
  const app = createApp({
    db,
    config: testConfig(),
    log: silentLog,
    mutations,
    mail: deps as never,
  })
  try {
    const cli = issueToken(db, { kind: 'cli', name: 'Owner', scopes: ['admin'] })
    const readOnly = issueToken(db, { kind: 'desktop', name: 'Read only', scopes: ['read'] })
    const agent = issueToken(db, {
      kind: 'agent',
      name: 'Agent',
      scopes: ['read', 'organize'],
      expiresAt: Date.now() + DAY_MS,
    })
    const body = JSON.stringify({
      accountId: 'a',
      address: 'alice@example.com',
      decision: 'accept',
      expectedRevision: 0,
      clientActionId: 'da6532af-9274-4b57-8225-c25d04ed74d1',
    })
    const call = (secret: string, path: string, method = 'GET') =>
      app.request(path, {
        method,
        headers: { Authorization: `Bearer ${secret}`, 'Content-Type': 'application/json' },
        ...(method === 'POST' ? { body } : {}),
      })
    for (const { secret } of [readOnly, agent]) {
      expect((await call(secret, '/v1/senders')).status).toBe(403)
      expect((await call(secret, '/v1/senders/decisions', 'POST')).status).toBe(403)
      expect((await call(secret, '/v1/owner-actions/nope/undo', 'POST')).status).toBe(403)
      expect((await call(secret, '/v1/sender-avatars/resolve', 'POST')).status).toBe(403)
      expect((await call(secret, '/v1/triage/queue')).status).toBe(403)
    }
    const accepted = await call(cli.secret, '/v1/senders/decisions', 'POST')
    expect(accepted.status).toBe(200)
    const { actionId } = await accepted.json()
    expect(await (await call(cli.secret, `/v1/owner-actions/${actionId}`)).json()).toMatchObject({
      status: 'applied',
    })
    expect(
      await (await call(cli.secret, `/v1/owner-actions/${actionId}/undo`, 'POST')).json(),
    ).toMatchObject({ revision: 2, undo: { status: 'applied' } })
    expect((await call(cli.secret, '/v1/sender-avatars/resolve', 'POST')).status).toBe(501)
    expect((await call(cli.secret, '/v1/triage/queue')).status).toBe(501)
  } finally {
    await mutations.stop()
    db.close()
  }
})

it.each([false, true])(
  'correlates a failed MCP tool with its Engine request (client ID %s)',
  async (providedId) => {
    const deps = setup()
    const token = issueToken(deps.db, {
      kind: 'agent',
      name: 'synthetic',
      scopes: ['read'],
      expiresAt: Date.now() + DAY_MS,
    })
    const app = createApp({
      db: deps.db,
      config: testConfig(),
      log: silentLog,
      mail: deps as never,
    })
    const canary = 'Synthetic Subject synthetic@example.test https://synthetic.invalid/path'
    const requestId = providedId ? newRequestId() : undefined
    const records: string[] = []
    const write = process.stdout.write.bind(process.stdout)
    const spy = vi
      .spyOn(process.stdout, 'write')
      .mockImplementation((value, ...args: unknown[]) => {
        const line = String(value)
        if (line.includes('"event":"mcp.tool.failed"')) {
          records.push(line)
          return true
        }
        return Reflect.apply(write, process.stdout, [value, ...args])
      })
    try {
      const response = await app.request('/mcp', {
        method: 'POST',
        headers: {
          Authorization: `Bearer ${token.secret}`,
          Accept: 'application/json, text/event-stream',
          'Content-Type': 'application/json',
          ...(requestId ? { [REQUEST_ID_HEADER]: requestId } : {}),
        },
        body: JSON.stringify({
          jsonrpc: '2.0',
          id: 1,
          method: 'tools/call',
          params: { name: 'get_thread', arguments: { thread_id: canary } },
        }),
      })
      expect(response.status).toBe(200)
      expect(await response.json()).toMatchObject({ result: { isError: true } })
      const returned = response.headers.get(REQUEST_ID_HEADER)
      expect(isCorrelationId(returned)).toBe(true)
      if (requestId) expect(returned).toBe(requestId)
      expect(records).toHaveLength(1)
      expect(JSON.parse(records[0] ?? '')).toMatchObject({
        event: 'mcp.tool.failed',
        operation: 'engine-tool',
        tool: 'get_thread',
        requestId: returned,
      })
      expect(records[0]).not.toContain(canary)
    } finally {
      spy.mockRestore()
    }
  },
)
