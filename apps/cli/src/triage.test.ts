import { Client } from '@modelcontextprotocol/sdk/client/index.js'
import { StreamableHTTPClientTransport } from '@modelcontextprotocol/sdk/client/streamableHttp.js'
import { McpServer } from '@modelcontextprotocol/sdk/server/mcp.js'
import { WebStandardStreamableHTTPServerTransport } from '@modelcontextprotocol/sdk/server/webStandardStreamableHttp.js'
import { afterEach, describe, expect, it, vi } from 'vitest'
import { z } from 'zod'
import { runTriage, type TriageHarness } from './triage.ts'

const config = { engineUrl: 'http://engine.invalid', token: 'owner' }
const decision = { threadId: 'a:t1', bucket: 'Reply', reason: 'The sender asked a question' }
const signal = () => new AbortController().signal

function fixture({ lostMint = false, revokeFailures = 0, dryRun = false } = {}) {
  const setBucket = vi.fn(() => ({ updated: true }))
  const getThread = vi.fn(() => ({ id: 'a:t1' }))
  const revoke = vi.fn()
  const list = vi.fn()
  let grantName: string
  const originalFetch = globalThis.fetch
  vi.stubGlobal('fetch', async (input: Parameters<typeof fetch>[0], init?: RequestInit) => {
    const req = new Request(input, init)
    const url = new URL(req.url)
    if (url.origin !== config.engineUrl) return originalFetch(input, init)
    if (url.pathname === '/v1/tokens') {
      expect(req.headers.get('Authorization')).toBe('Bearer owner')
      if (req.method === 'GET') {
        list()
        return Response.json({
          tokens: [
            { id: 'different-run', name: 'triage-other', kind: 'agent', revoked_at: null },
            { id: 'test-token', name: grantName, kind: 'agent', revoked_at: null },
          ],
        })
      }
      expect(req.method).toBe('POST')
      const body = await req.json()
      expect(body).toEqual({
        name: expect.stringMatching(/^triage-[0-9a-f-]{36}$/),
        accountId: 'a',
        scopes: dryRun ? ['read'] : ['read', 'organize'],
        expiresInMinutes: 5,
      })
      grantName = z.object({ name: z.string() }).parse(body).name
      if (lostMint) throw new Error('Lost mint response')
      return Response.json({ id: 'test-token', token: 'agent' })
    }
    if (url.pathname === '/v1/tokens/test-token') {
      expect(req.method).toBe('DELETE')
      expect(req.headers.get('Authorization')).toBe('Bearer owner')
      revoke()
      if (revoke.mock.calls.length <= revokeFailures)
        return Response.json({ error: 'temporary' }, { status: 503 })
      return Response.json({ revoked: 'test-token' })
    }
    expect(url.pathname).toBe('/mcp')
    expect(req.headers.get('Authorization')).toBe('Bearer agent')
    const server = new McpServer({ name: 'engine-fixture', version: '1' })
    const json = (data: unknown) => ({
      content: [{ type: 'text' as const, text: JSON.stringify(data) }],
    })
    server.registerTool('list_untriaged', { inputSchema: { limit: z.number() } }, async () =>
      json([{ id: 'a:t1', subject: 'Fixture' }]),
    )
    server.registerTool('get_thread', { inputSchema: { thread_id: z.string() } }, async () =>
      json(getThread()),
    )
    server.registerTool(
      'set_bucket',
      {
        inputSchema: {
          threadId: z.string(),
          bucket: z.string(),
          reason: z.string(),
          onlyUntriaged: z.boolean(),
        },
      },
      async (args) => {
        expect(args).toEqual({ ...decision, onlyUntriaged: true })
        return json(setBucket())
      },
    )
    const transport = new WebStandardStreamableHTTPServerTransport({ enableJsonResponse: true })
    await server.connect(transport)
    return transport.handleRequest(req)
  })
  return { getThread, setBucket, revoke, list }
}

const harness: TriageHarness = async ({ url, bearer, allowReads }) => {
  const client = new Client({ name: 'stub-harness', version: '1' })
  await client.connect(
    new StreamableHTTPClientTransport(new URL(url), {
      requestInit: { headers: { Authorization: `Bearer ${bearer}` } },
    }),
  )
  try {
    const { tools } = await client.listTools()
    expect(tools.map(({ name }) => name)).toEqual(['list_untriaged', 'get_thread'])
    allowReads()
    const result = await client.callTool({ name: 'list_untriaged', arguments: {} })
    expect(result.content).toEqual([{ type: 'text', text: '[{"id":"a:t1","subject":"Fixture"}]' }])
    expect(
      await client.callTool({ name: 'get_thread', arguments: { thread_id: 'outside' } }),
    ).toHaveProperty('isError', true)
    expect(
      await client.callTool({ name: 'get_thread', arguments: { thread_id: 'a:t1' } }),
    ).not.toHaveProperty('isError', true)
    expect(await client.callTool({ name: 'set_bucket', arguments: decision })).toHaveProperty(
      'isError',
      true,
    )
    return { decisions: [decision] }
  } finally {
    await client.close()
  }
}

afterEach(() => vi.unstubAllGlobals())

describe('amc triage', () => {
  it.each([true, false])(
    'applies only validated decisions and revokes the token (dry-run %s)',
    async (dryRun) => {
      const { getThread, setBucket, revoke } = fixture({ dryRun })
      expect(await runTriage(config, 'a', dryRun, signal(), harness)).toEqual([
        dryRun ? decision : { ...decision, updated: true },
      ])
      expect(getThread).toHaveBeenCalledOnce()
      expect(setBucket).toHaveBeenCalledTimes(dryRun ? 0 : 1)
      expect(revoke).toHaveBeenCalledOnce()
    },
  )

  it('finds and revokes the named grant after a lost mint response', async () => {
    const { list, revoke } = fixture({ lostMint: true })
    const model = vi.fn(harness)
    await expect(runTriage(config, 'a', false, signal(), model)).rejects.toThrow(
      'Lost mint response',
    )
    expect(list).toHaveBeenCalledOnce()
    expect(revoke).toHaveBeenCalledOnce()
    expect(model).not.toHaveBeenCalled()
  })

  it('retries transient revoke failures', async () => {
    const { list, revoke } = fixture({ revokeFailures: 2 })
    await expect(runTriage(config, 'a', false, signal(), harness)).resolves.toMatchObject([
      { ...decision, updated: true },
    ])
    expect(revoke).toHaveBeenCalledTimes(3)
    expect(list).not.toHaveBeenCalled()
  })

  it('rejects decisions outside the batch and still revokes the token', async () => {
    const { setBucket, revoke } = fixture()
    await expect(
      runTriage(config, 'a', false, signal(), async () => ({
        decisions: [{ ...decision, threadId: 'outside' }],
      })),
    ).rejects.toThrow('one decision for each Thread')
    expect(setBucket).not.toHaveBeenCalled()
    expect(revoke).toHaveBeenCalledOnce()
  })

  it('revokes the token if the harness fails', async () => {
    const { setBucket, revoke } = fixture()
    await expect(
      runTriage(config, 'a', false, signal(), async () => {
        throw new Error('Stub harness failed')
      }),
    ).rejects.toThrow('Stub harness failed')
    expect(setBucket).not.toHaveBeenCalled()
    expect(revoke).toHaveBeenCalledOnce()
  })
})
