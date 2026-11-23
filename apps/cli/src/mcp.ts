import { type EventFields, RUN_ID_HEADER } from '@amc/observability'
import { mcpClientObservability } from '@amc/observability/mcp-client'
import { MCP_REQUIRE_AGENT_HEADER } from '@amc/protocol'
import { Client } from '@modelcontextprotocol/sdk/client/index.js'
import { StreamableHTTPClientTransport } from '@modelcontextprotocol/sdk/client/streamableHttp.js'
import type { CliConfig } from './config.ts'
import { cliContext, clientLog } from './observability.ts'

type Tool = Exclude<EventFields<'mcp.tool.failed'>['tool'], 'transport'>

class McpCommandError extends Error {}

export async function mailTool<T>(
  config: CliConfig,
  agent: boolean,
  name: Tool,
  args: Record<string, unknown> = {},
  options: { checked?: boolean; write?: boolean } = {},
): Promise<T> {
  const client = new Client({ name: 'amc-cli', version: '1' })
  const context = cliContext.getStore()
  const signal = AbortSignal.timeout(30_000)
  let submitted = false
  const observed = mcpClientObservability(
    () => clientLog('mcp'),
    (requestId) => {
      if (context) context.requestId = requestId
    },
  )
  const transport = new StreamableHTTPClientTransport(new URL('/mcp', config.engineUrl), {
    requestInit: {
      headers: {
        Authorization: `Bearer ${config.token}`,
        ...(context?.runId ? { [RUN_ID_HEADER]: context.runId } : {}),
        ...(agent ? { [MCP_REQUIRE_AGENT_HEADER]: '1' } : {}),
      },
      redirect: 'error',
    },
    fetch: async (input, init) => {
      const response = await observed.fetch(input, init)
      if (agent && response.headers.get(MCP_REQUIRE_AGENT_HEADER) !== '1') {
        await response.body?.cancel()
        if (submitted && options.write && response.status !== 401 && response.status !== 403) {
          throw new Error('The response did not verify the agent credential.')
        }
        throw new McpCommandError(
          'Agent access requires a scoped token and an Engine that supports CLI agent mode.',
        )
      }
      return response
    },
  })
  try {
    await observed.call('transport', context?.runId, () => client.connect(transport, { signal }))
    if (options.checked) {
      const { tools } = await client.listTools(undefined, { signal })
      const tool = tools.find((item) => item.name === name)
      const properties = tool?.inputSchema.properties ?? {}
      if (!tool || Object.keys(args).some((key) => !Object.hasOwn(properties, key))) {
        throw new McpCommandError(
          'This credential or Engine does not support the requested revision-checked draft change.',
        )
      }
    }
    submitted = true
    const { result } = await observed.call(
      name,
      context?.runId,
      () => client.callTool({ name, arguments: args }, undefined, { signal }),
      (result) => result.isError === true,
    )
    const content = result.content
    const text = Array.isArray(content) && content[0]?.type === 'text' ? content[0].text : undefined
    if (result.isError) {
      if (typeof text !== 'string') throw new McpCommandError('The Engine rejected the operation.')
      let error: { error?: string; revision?: number } | undefined
      try {
        error = JSON.parse(text)
      } catch {
        throw new McpCommandError(text)
      }
      if (error?.error === 'conflict' && Number.isSafeInteger(error.revision)) {
        throw new McpCommandError(
          `The draft changed (revision ${error.revision}). Review it before retrying.`,
        )
      }
      throw new McpCommandError('The Engine rejected the operation.')
    }
    if (typeof text !== 'string') throw new Error('Missing result')
    return JSON.parse(text) as T
  } catch (error) {
    if (error instanceof McpCommandError) throw error
    if (submitted && options.write) {
      throw new McpCommandError(
        'The Engine did not confirm the write. Check AMC before retrying to avoid a duplicate change.',
      )
    }
    throw new McpCommandError('The Engine MCP request failed. Check the connection and credential.')
  } finally {
    await client.close().catch(() => {})
  }
}
