import { mkdtemp, readFile, rm } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { isCorrelationId, newRunId, REQUEST_ID_HEADER, RUN_ID_HEADER } from '@amc/observability'
import { cliLogDirectory } from '@amc/observability/node'
import { SubmitTriagePrediction } from '@amc/protocol'
import { Client } from '@modelcontextprotocol/sdk/client/index.js'
import { StreamableHTTPClientTransport } from '@modelcontextprotocol/sdk/client/streamableHttp.js'
import { McpServer } from '@modelcontextprotocol/sdk/server/mcp.js'
import { WebStandardStreamableHTTPServerTransport } from '@modelcontextprotocol/sdk/server/webStandardStreamableHttp.js'
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import { z } from 'zod'
import { closeClientLogs } from './observability.ts'
import { runTriage, type TriageHarness, triageWithGrant, withTriageGrant } from './triage.ts'

const config = { engineUrl: 'http://engine.invalid', token: 'owner' }
const decision = { threadId: 'a:t1', bucket: 'Reply', reason: 'The sender asked a question' }
const signal = () => new AbortController().signal

function fixture({
  lostMint = false,
  revokeFailures = 0,
  dryRun = false,
  recent = false,
  busy = false,
  modern = false,
  decisionLog = false,
  expectedReason = decision.reason,
} = {}) {
  const setBucket = vi.fn(() =>
    modern ? { updated: false, reason: 'The Inbox input changed' } : { updated: true },
  )
  const submit = vi.fn()
  const runId = 'f6c88c1e-10ed-47b7-84ed-ef7b28b88136'
  const ref = { threadId: 'a:t1', messageId: 'a:m1', arrivalKey: 'a:m1', inputRevision: 19 }
  const getThread = vi.fn(() => ({ id: 'a:t1' }))
  const revoke = vi.fn()
  const list = vi.fn()
  const mint = vi.fn()
  let holder: string
  let grantName: string
  const originalFetch = globalThis.fetch
  const engineRequests: { requestId: string | null; runId: string | null }[] = []
  vi.stubGlobal('fetch', async (input: Parameters<typeof fetch>[0], init?: RequestInit) => {
    const req = new Request(input, init)
    const url = new URL(req.url)
    if (url.origin !== config.engineUrl) return originalFetch(input, init)
    if (url.pathname === '/v1/triage/lease') {
      expect(req.headers.get('Authorization')).toBe('Bearer owner')
      const body = z.object({ holder: z.string() }).parse(await req.json())
      if (req.method === 'POST') {
        holder = body.holder
        return Response.json({ granted: !busy })
      }
      expect(req.method).toBe('DELETE')
      expect(body.holder).toBe(holder)
      expect(revoke).toHaveBeenCalled()
      return new Response(null, { status: 204 })
    }
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
      mint()
      const body = await req.json()
      expect(body).toEqual({
        name: expect.stringMatching(/^triage-[0-9a-f-]{36}$/),
        accountId: 'a',
        scopes: dryRun ? ['read'] : ['read', 'organize'],
        expiresInMinutes: 5,
      })
      grantName = z.object({ name: z.string() }).parse(body).name
      expect(grantName).toBe(holder)
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
    engineRequests.push({
      requestId: req.headers.get(REQUEST_ID_HEADER),
      runId: req.headers.get(RUN_ID_HEADER),
    })
    expect(req.headers.get('Authorization')).toBe('Bearer agent')
    const server = new McpServer({ name: 'engine-fixture', version: '1' })
    const json = (data: unknown) => ({
      content: [{ type: 'text' as const, text: JSON.stringify(data) }],
    })
    server.registerTool(
      'list_untriaged',
      {
        inputSchema: {
          limit: z.number(),
          recent: z.boolean().optional(),
          reviewContext: z.boolean(),
          decisionLogVersion: z.number().optional(),
        },
      },
      async (args) => {
        expect(args.recent).toBe(recent ? true : undefined)
        expect(args.reviewContext).toBe(true)
        if (decisionLog) {
          expect(args.decisionLogVersion).toBe(1)
          return json({
            threads: [{ id: 'a:t1', subject: 'Fixture' }],
            decisionLogVersion: 1,
            receipt: 'opaque',
            runId,
            refs: [{ ...ref, exampleIds: ['fixture-event'] }],
            examples: {
              targets: { 'a:t1': ['fixture-event'] },
              examples: [
                {
                  id: 'fixture-event',
                  axis: 'filter',
                  labelId: 'filter.keep',
                  features: {
                    version: 1,
                    senderHash: null,
                    senderKeyVersion: null,
                    domain: 'example.test',
                    listId: null,
                    hasListUnsubscribe: null,
                    category: null,
                  },
                  ignoredPrivateField: 'Synthetic private canary',
                },
              ],
            },
          })
        }
        if (modern)
          return json({
            threads: [{ id: 'a:t1', subject: 'Fixture', inputRevision: 19 }],
            examples: [
              {
                previous: 'Action',
                chosen: 'Later',
                ownerReason: 'Synthetic owner preference',
                context: { subject: 'Synthetic example', snippet: '' },
              },
            ],
          })
        return json([{ id: 'a:t1', subject: 'Fixture' }])
      },
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
          triage: z.object({ inputRevision: z.number(), confidence: z.string() }).optional(),
        },
      },
      async (args) => {
        expect(args).toEqual({
          ...decision,
          reason: expectedReason,
          onlyUntriaged: true,
          ...(modern ? { triage: { inputRevision: 19, confidence: 'low' } } : {}),
        })
        return json(setBucket())
      },
    )
    if (decisionLog) {
      server.registerTool(
        'submit_triage_prediction',
        { inputSchema: SubmitTriagePrediction },
        async (input) => {
          expect(input).toMatchObject({ receipt: 'opaque', runId, input: ref })
          submit(input)
          return json({
            runId,
            outcomes: [
              { axis: 'bucket', eventId: 'fixture-bucket', projection: 'applied' },
              { axis: 'filter', eventId: 'fixture-filter', projection: 'suggested' },
            ],
          })
        },
      )
    }
    const transport = new WebStandardStreamableHTTPServerTransport({ enableJsonResponse: true })
    await server.connect(transport)
    return transport.handleRequest(req)
  })
  return { getThread, setBucket, revoke, list, mint, submit, engineRequests }
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

let logHome: string
beforeEach(async () => {
  logHome = await mkdtemp(join(tmpdir(), 'amc-triage-test-'))
  vi.stubEnv('HOME', logHome)
  vi.stubEnv('XDG_STATE_HOME', logHome)
})
afterEach(async () => {
  await closeClientLogs()
  vi.unstubAllGlobals()
  vi.unstubAllEnvs()
  await rm(logHome, { recursive: true, force: true })
})

describe('amc triage', () => {
  it('uses the admitted worker run ID in Engine MCP requests and CLI logs', async () => {
    vi.stubEnv('AMC_LOG_LEVEL', 'info')
    const { engineRequests } = fixture({ dryRun: true })
    const runId = newRunId()
    const stop = async () => {
      throw new Error('Worker fixture failure')
    }
    await expect(
      triageWithGrant({ ...config, token: 'agent' }, true, false, signal(), stop, runId),
    ).rejects.toThrow('Worker fixture failure')
    await closeClientLogs()

    expect(engineRequests.length).toBeGreaterThan(1)
    expect(engineRequests.every((request) => request.runId === runId)).toBe(true)
    const requests = engineRequests.map(({ requestId }) => requestId)
    expect(requests.every(isCorrelationId)).toBe(true)
    expect(new Set(requests).size).toBe(requests.length)
    const logs = await readFile(join(cliLogDirectory(), 'cli.log'), 'utf8')
    expect(
      logs
        .trim()
        .split('\n')
        .map((line) => JSON.parse(line)),
    ).toEqual([
      expect.objectContaining({ event: 'span.started', operation: 'triage.run', runId }),
      expect.objectContaining({ event: 'span.finished', outcome: 'error', runId }),
    ])
  })

  it('passes Claude a schema without the Draft 2020-12 meta-schema', async () => {
    fixture({ dryRun: true })
    await runTriage(config, 'a', true, signal(), async ({ schema }) => {
      expect(schema).not.toHaveProperty('$schema', 'https://json-schema.org/draft/2020-12/schema')
      return { decisions: [decision] }
    })
  })

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

  it('ignores legacy private and copied examples while submitting Bucket metadata', async () => {
    const reason = 'Context: The print shop needs a decision. | Action: Approve the proof.'
    fixture({ modern: true, expectedReason: reason })
    const results = await runTriage(config, 'a', false, signal(), async ({ prompt }) => {
      expect(prompt).toMatch(/For Update, Later, and\s+When I have time, use only `Context: …`/)
      expect(prompt).toMatch(/For Reply, Action,\s+and Follow-up, use `Context: … \| Action: …`/)
      expect(prompt).not.toContain('Synthetic example')
      expect(prompt).not.toContain('Synthetic owner preference')
      expect(prompt).not.toContain('"chosen":"Later"')
      return { decisions: [{ ...decision, reason, confidence: 'low', inputRevision: 99 }] }
    })
    expect(results).toEqual([
      {
        ...decision,
        reason,
        confidence: 'low',
        updated: false,
        skipped: 'The Inbox input changed',
      },
    ])
  })

  it.each([true, false])(
    'uses the advertised decision log contract and separate axes (dry-run %s)',
    async (dryRun) => {
      const { submit, setBucket, revoke } = fixture({ decisionLog: true, dryRun })
      const outputs = {
        bucket: {
          labelId: 'bucket.reply',
          confidence: 'low',
          matchedRuleRevisionId: null,
          displayReason: dryRun
            ? 'Context: The print shop confirmed the delivery date.'
            : 'Context: The print shop needs a decision. | Action: Approve the proof.',
        },
        filter: { labelId: 'filter.filtered', confidence: 'high', matchedRuleRevisionId: null },
        protection: 'billing',
      }
      const result = await runTriage(config, 'a', dryRun, signal(), async (request) => {
        expect(request.prompt).toMatch(
          /For Update, Later, and\s+When I have time, use only `Context: …`/,
        )
        expect(request.prompt).toMatch(
          /For Reply, Action,\s+and Follow-up, use `Context: … \| Action: …`/,
        )
        expect(request.prompt).toContain('"fixture-event"')
        expect(request.prompt).toContain('"filter.keep"')
        expect(request.prompt).not.toContain('Synthetic private canary')
        expect(request.prompt).not.toContain('opaque')
        await harness(request)
        request.onModel?.('fixture-model')
        return { decisions: [{ threadId: 'a:t1', ...outputs }] }
      })
      expect(result).toMatchObject([
        { threadId: 'a:t1', ...outputs, ...(dryRun ? {} : { updated: true }) },
      ])
      expect(setBucket).not.toHaveBeenCalled()
      expect(submit).toHaveBeenCalledTimes(dryRun ? 0 : 1)
      if (!dryRun)
        expect(submit).toHaveBeenCalledWith(
          expect.objectContaining({
            outputs,
            producer: expect.objectContaining({
              modelId: 'fixture-model',
              promptVersion: expect.stringMatching(/^[a-f0-9]{64}$/),
            }),
          }),
        )
      expect(revoke).toHaveBeenCalledOnce()
    },
  )

  it('requests recent deliveries when opted in', async () => {
    fixture({ recent: true })
    expect(await runTriage(config, 'a', false, signal(), harness, true)).toHaveLength(1)
  })

  it('skips without minting a grant when another client holds the lease', async () => {
    const { mint } = fixture({ busy: true })
    const model = vi.fn(harness)
    await expect(runTriage(config, 'a', false, signal(), model)).resolves.toBeNull()
    expect(mint).not.toHaveBeenCalled()
    expect(model).not.toHaveBeenCalled()
  })

  it('finds and revokes the named grant after a lost mint response', async () => {
    const { list, revoke } = fixture({ lostMint: true })
    const model = vi.fn(harness)
    await expect(runTriage(config, 'a', false, signal(), model)).rejects.toThrow(
      'Could not reach the Engine',
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
    ).rejects.toThrow('returned invalid triage decisions')
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

it('retries lease acquisition once after the Engine confirms cleanup', async () => {
  const requests: string[] = []
  let holder: string | undefined
  let firstAttempt = true
  const run = vi.fn(async () => 'triaged')
  vi.stubGlobal('fetch', async (url: URL, init: RequestInit) => {
    const request = `${init.method} ${url.pathname}`
    requests.push(request)
    const body = init.body ? JSON.parse(String(init.body)) : undefined
    switch (request) {
      case 'POST /v1/triage/lease':
        expect(holder).toBeUndefined()
        holder = body.holder
        if (firstAttempt) {
          firstAttempt = false
          throw new DOMException('Synthetic lost response', 'TimeoutError')
        }
        return Response.json({ granted: true })
      case 'DELETE /v1/triage/lease':
        expect(body.holder).toBe(holder)
        holder = undefined
        return new Response(null, { status: 204 })
      case 'POST /v1/tokens':
        expect(body.name).toBe(holder)
        return Response.json({ id: 'test-token', token: 'agent' })
      case 'DELETE /v1/tokens/test-token':
        return new Response(null, { status: 204 })
      default:
        throw new Error(request)
    }
  })
  await expect(withTriageGrant(config, 'a', false, signal(), run)).resolves.toBe('triaged')
  expect(run).toHaveBeenCalledOnce()
  expect(holder).toBeUndefined()
  expect(requests).toEqual([
    'POST /v1/triage/lease',
    'DELETE /v1/triage/lease',
    'POST /v1/triage/lease',
    'POST /v1/tokens',
    'DELETE /v1/tokens/test-token',
    'DELETE /v1/triage/lease',
  ])
})

it('releases its lease when both acquisition responses are lost', async () => {
  let holder: string | undefined
  const acquire = vi.fn()
  vi.stubGlobal('fetch', async (_url: URL, init: RequestInit) => {
    const body = JSON.parse(String(init.body))
    if (init.method === 'POST') {
      acquire()
      expect(holder).toBeUndefined()
      holder = body.holder
      throw new Error('Lost lease response')
    }
    expect(init.method).toBe('DELETE')
    expect(body.holder).toBe(holder)
    holder = undefined
    return new Response(null, { status: 204 })
  })
  const model = vi.fn(harness)
  await expect(runTriage(config, 'a', false, signal(), model)).rejects.toThrow(
    'Could not reach the Engine',
  )
  expect(holder).toBeUndefined()
  expect(acquire).toHaveBeenCalledTimes(2)
  expect(model).not.toHaveBeenCalled()
})

it.each(['release failed', 'run aborted'])(
  'stops acquisition recovery when %s',
  async (outcome) => {
    const controller = new AbortController()
    const requests: string[] = []
    const run = vi.fn()
    vi.stubGlobal('fetch', async (url: URL, init: RequestInit) => {
      requests.push(`${init.method} ${url.pathname}`)
      if (init.method === 'POST') throw new DOMException('Synthetic timeout', 'TimeoutError')
      if (outcome === 'release failed') return new Response(null, { status: 503 })
      controller.abort()
      return new Response(null, { status: 204 })
    })

    await expect(withTriageGrant(config, 'a', false, controller.signal, run)).rejects.toMatchObject(
      {
        reason: 'engine-timeout',
      },
    )
    expect(requests).toEqual(['POST /v1/triage/lease', 'DELETE /v1/triage/lease'])
    expect(run).not.toHaveBeenCalled()
  },
)

it('reserves time to release the lease if grant revocation times out', async () => {
  const release = vi.fn()
  vi.stubGlobal('fetch', async (url: URL, init: RequestInit) => {
    if (url.pathname === '/v1/triage/lease') {
      if (init.method === 'POST') return Response.json({ granted: true })
      release(init.signal?.aborted)
      return new Response(null, { status: 204 })
    }
    if (init.method === 'POST') return Response.json({ id: 'test-token', token: 'agent' })
    if (init.method === 'GET') {
      // AbortSignal.timeout uses an unref'd timer. Keep the fixture alive until it fires.
      await new Promise<void>((resolve) => {
        const guard = setTimeout(resolve, 1_000)
        init.signal?.addEventListener(
          'abort',
          () => {
            clearTimeout(guard)
            resolve()
          },
          { once: true },
        )
      })
      throw init.signal?.reason
    }
    throw new Error('Unexpected fixture operation')
  })
  await expect(
    withTriageGrant(config, 'a', false, signal(), async () => [], 60),
  ).rejects.toMatchObject({ reason: 'engine-cleanup' })
  expect(release).toHaveBeenCalledExactlyOnceWith(false)
})
