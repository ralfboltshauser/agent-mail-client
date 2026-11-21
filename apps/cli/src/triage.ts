import { randomUUID } from 'node:crypto'
import { readFileSync } from 'node:fs'
import { createServer } from 'node:http'
import type { AddressInfo } from 'node:net'
import { setTimeout as delay } from 'node:timers/promises'
import { Bucket, BucketInput } from '@amc/protocol'
import { Client } from '@modelcontextprotocol/sdk/client/index.js'
import { StreamableHTTPClientTransport } from '@modelcontextprotocol/sdk/client/streamableHttp.js'
import { McpServer } from '@modelcontextprotocol/sdk/server/mcp.js'
import { StreamableHTTPServerTransport } from '@modelcontextprotocol/sdk/server/streamableHttp.js'
import { type CallToolResult, CallToolResultSchema } from '@modelcontextprotocol/sdk/types.js'
import { z } from 'zod'
import { authed, EngineError } from './client.ts'
import type { CliConfig } from './config.ts'
import { runClaude } from './triage-claude.ts'

declare const AMC_TRIAGE_PROMPT: string | undefined
const BATCH_SIZE = 20
const Decisions = z.object({
  decisions: z.array(BucketInput.extend({ bucket: Bucket })).max(BATCH_SIZE),
})
// Claude's structured output supports the shape and enum. AMC validates lengths locally.
export const ModelDecisions = z.object({
  decisions: z.array(z.object({ threadId: z.string(), bucket: Bucket, reason: z.string() })),
})
export const triageJsonSchema = z.toJSONSchema(ModelDecisions, { target: 'draft-7' })
const ListedThreads = z.array(z.object({ id: z.string() }).passthrough())
const TOOL_NAMES = ['list_untriaged', 'get_thread'] as const

export type TriageHarness = (request: {
  url: string
  bearer: string
  prompt: string
  schema: object
  tools: readonly string[]
  signal: AbortSignal
  allowReads: () => void
}) => Promise<unknown>

function toolJson(result: CallToolResult): unknown {
  const content = result.content[0]
  if (result.isError || content?.type !== 'text') throw new Error('Engine triage MCP call failed')
  return JSON.parse(content.text)
}

export async function runTriage(
  config: CliConfig,
  accountId: string,
  dryRun: boolean,
  interrupt: AbortSignal,
  harness: TriageHarness = runClaude,
) {
  const signal = AbortSignal.any([interrupt, AbortSignal.timeout(120_000)])
  const api = authed(config)
  const name = `triage-${randomUUID()}`
  const client = new Client({ name: 'amc-triage', version: '1' })
  signal.throwIfAborted()
  let id: string | undefined
  let runError: unknown
  try {
    const grant = await api<{ id: string; token: string }>('/v1/tokens', {
      method: 'POST',
      body: {
        name,
        accountId,
        scopes: dryRun ? ['read'] : ['read', 'organize'],
        expiresInMinutes: 5,
      },
      signal: AbortSignal.any([signal, AbortSignal.timeout(10_000)]),
      redirect: 'error',
    })
    id = grant.id
    signal.throwIfAborted()
    await client.connect(
      new StreamableHTTPClientTransport(new URL('/mcp', config.engineUrl), {
        requestInit: { headers: { Authorization: `Bearer ${grant.token}` }, redirect: 'error' },
      }),
      { signal },
    )
    const call = (name: string, args: Record<string, unknown> = {}) =>
      client
        .callTool({ name, arguments: args }, CallToolResultSchema, { signal })
        .then((result) => CallToolResultSchema.parse(result))
    const batch = ListedThreads.parse(toolJson(await call('list_untriaged', { limit: BATCH_SIZE })))
    if (!batch.length) return []

    const ids = new Set(batch.map((thread) => thread.id))
    const forwarder = await startForwarder(
      batch,
      ids,
      (threadId) => call('get_thread', { thread_id: threadId }),
      signal,
    )
    try {
      const proposal = await harness({
        url: forwarder.url,
        bearer: forwarder.bearer,
        tools: TOOL_NAMES.map((name) => `mcp__amc__${name}`),
        prompt:
          typeof AMC_TRIAGE_PROMPT === 'string'
            ? AMC_TRIAGE_PROMPT
            : readFileSync(new URL('../prompts/triage.md', import.meta.url), 'utf8'),
        schema: triageJsonSchema,
        signal,
        allowReads: forwarder.allowReads,
      })
      signal.throwIfAborted()
      const { decisions } = Decisions.parse(proposal)
      const chosen = new Set(decisions.map((decision) => decision.threadId))
      if (
        decisions.length !== ids.size ||
        chosen.size !== ids.size ||
        [...chosen].some((id) => !ids.has(id))
      )
        throw new Error('Triage must return one decision for each Thread in the batch')
      if (dryRun) return decisions

      const results = []
      for (const decision of decisions) {
        const { updated } = z
          .object({ updated: z.boolean() })
          .parse(toolJson(await call('set_bucket', { ...decision, onlyUntriaged: true })))
        results.push({ ...decision, updated })
      }
      return results
    } finally {
      forwarder.close()
    }
  } catch (error) {
    runError = error
    throw error
  } finally {
    await client.close().finally(() =>
      revokeTriageGrant(api, name, id).catch((error: unknown) => {
        const message = `Could not revoke grant ${name}. It expires five minutes after minting.`
        if (runError) throw new AggregateError([runError, error], message)
        throw new Error(message, { cause: error })
      }),
    )
  }
}

async function revokeTriageGrant(api: ReturnType<typeof authed>, name: string, id?: string) {
  for (let attempt = 0; attempt < 3; attempt++) {
    if (attempt) await delay(250 * attempt)
    const options = { signal: AbortSignal.timeout(10_000), redirect: 'error' as const }
    try {
      if (!id) {
        const { tokens } = await api<{
          tokens: { id: string; kind: string; name: string; revoked_at: number | null }[]
        }>('/v1/tokens', options)
        id = tokens.find(
          (token) => token.kind === 'agent' && token.name === name && token.revoked_at === null,
        )?.id
        // After a lost response the server may still be processing the mint.
        if (!id) continue
      }
      await api(`/v1/tokens/${encodeURIComponent(id)}`, { ...options, method: 'DELETE' })
      return
    } catch (error) {
      if (id && error instanceof EngineError && error.status === 404) return
      if (
        attempt === 2 ||
        (error instanceof EngineError &&
          error.status >= 400 &&
          error.status < 500 &&
          error.status !== 408 &&
          error.status !== 429)
      )
        throw error
    }
  }
}

async function startForwarder(
  batch: z.infer<typeof ListedThreads>,
  ids: Set<string>,
  getThread: (id: string) => Promise<CallToolResult>,
  signal: AbortSignal,
) {
  const bearer = randomUUID()
  let allowReads!: () => void
  const ready = new Promise<void>((resolve) => {
    allowReads = resolve
  })
  const aborted = new Promise<void>((resolve) => {
    if (signal.aborted) resolve()
    else signal.addEventListener('abort', () => resolve(), { once: true })
  })
  const verifyInventory = async () => {
    await Promise.race([ready, aborted])
    signal.throwIfAborted()
  }
  const server = createServer(async (req, res) => {
    if (req.url !== '/mcp' || req.headers.authorization !== `Bearer ${bearer}`) {
      res.writeHead(403).end()
      return
    }
    if (req.method !== 'POST') {
      res.writeHead(405).end()
      return
    }
    const mcp = new McpServer({ name: 'amc', version: '1' })
    mcp.registerTool(
      'list_untriaged',
      {
        description: 'List the current batch of untriaged Inbox Threads.',
        annotations: { readOnlyHint: true },
      },
      async () => {
        await verifyInventory()
        return { content: [{ type: 'text', text: JSON.stringify(batch) }] }
      },
    )
    mcp.registerTool(
      'get_thread',
      {
        description: 'Read a Thread in the current batch.',
        inputSchema: { thread_id: z.string() },
        annotations: { readOnlyHint: true },
      },
      async ({ thread_id }) => {
        if (!ids.has(thread_id))
          return {
            isError: true,
            content: [{ type: 'text', text: 'Thread is outside this batch' }],
          }
        await verifyInventory()
        return getThread(thread_id)
      },
    )
    const transport = new StreamableHTTPServerTransport({ enableJsonResponse: true })
    res.once('close', () => {
      void mcp.close()
    })
    try {
      await mcp.connect(transport)
      await transport.handleRequest(req, res)
    } catch {
      if (!res.headersSent) res.writeHead(500)
      res.end()
    }
  })
  await new Promise<void>((resolve, reject) => {
    server.once('error', reject)
    server.listen(0, '127.0.0.1', resolve)
  })
  return {
    url: `http://127.0.0.1:${(server.address() as AddressInfo).port}/mcp`,
    bearer,
    allowReads,
    close() {
      server.close()
      server.closeAllConnections()
    },
  }
}
