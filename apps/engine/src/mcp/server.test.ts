import { SCOPES, type Scope } from '@amc/protocol'
import { Client } from '@modelcontextprotocol/sdk/client/index.js'
import { InMemoryTransport } from '@modelcontextprotocol/sdk/inMemory.js'
import { describe, expect, it } from 'vitest'
import type { Principal } from '../auth/tokens.ts'
import { BlobStore } from '../blobs.ts'
import { Drafts } from '../mail/drafts.ts'
import { MailQueries } from '../mail/queries.ts'
import { MailStore } from '../mail/store.ts'
import { FakeGmail } from '../providers/gmail/fake.ts'
import { fromGmail } from '../providers/gmail/mapping.ts'
import { tempDir, testDb } from '../test-support.ts'
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
  return { db, store, gmail, drafts, queries: new MailQueries(db) }
}

async function connect(scopes: Scope[], deps = setup()) {
  const principal: Principal = { tokenId: 't', kind: 'agent', name: 't3', scopes, subject: null }
  const server = buildMcpServer(principal, {
    db: deps.db,
    queries: deps.queries,
    drafts: deps.drafts,
  })
  const [a, b] = InMemoryTransport.createLinkedPair()
  const client = new Client({ name: 'test', version: '0' })
  await Promise.all([server.connect(a), client.connect(b)])
  return { client, ...deps }
}

function combinations<T>(items: readonly T[]): T[][] {
  const all: T[][] = [[]]
  for (const item of items) {
    for (const combo of [...all]) all.push([...combo, item])
  }
  return all
}

const text = (result: unknown) => (result as { content: { text: string }[] }).content[0]?.text ?? ''

describe('MCP tools', () => {
  it('never exposes a way to send, for any combination of scopes (ADR 0001)', async () => {
    for (const scopes of combinations(SCOPES)) {
      const { client } = await connect(scopes)
      const { tools } = await client.listTools()
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
    expect(readTools).not.toContain('create_draft')
    const draft = await connect(['read', 'draft'])
    expect((await draft.client.listTools()).tools.map((t) => t.name)).toContain('create_draft')
  })

  it('reads a Thread and drafts a threaded reply that lands in Gmail', async () => {
    const { client, gmail } = await connect(['read', 'draft'])
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
          arguments: { draft_id: draft.id, body: 'Friday at 7?' },
        }),
      ),
    )
    expect(updated.body).toBe('Friday at 7?')
    expect(gmail.drafts.size).toBe(1)
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
})
