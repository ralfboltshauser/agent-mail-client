import { type EventFields, RUN_ID_HEADER } from '@amc/observability'
import { mcpClientObservability } from '@amc/observability/mcp-client'
import { MCP_CLI_AGENT_PATH, MCP_CLI_OWNER_PATH } from '@amc/protocol'
import { Client } from '@modelcontextprotocol/sdk/client/index.js'
import {
  StreamableHTTPClientTransport,
  StreamableHTTPError,
} from '@modelcontextprotocol/sdk/client/streamableHttp.js'
import type { CliConfig } from './config.ts'
import { cliContext, clientLog } from './observability.ts'

type Tool = Exclude<EventFields<'mcp.tool.failed'>['tool'], 'transport'>

class McpCommandError extends Error {}

export async function mailTool<T>(
  config: CliConfig,
  agent: boolean,
  name: Tool,
  args: Record<string, unknown> = {},
  options: { checked?: boolean; write?: boolean; result?: { parse(value: unknown): T } } = {},
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
  const path = agent ? MCP_CLI_AGENT_PATH : options.checked ? MCP_CLI_OWNER_PATH : '/mcp'
  const transport = new StreamableHTTPClientTransport(new URL(path, config.engineUrl), {
    requestInit: {
      headers: {
        Authorization: `Bearer ${config.token}`,
        ...(context?.runId ? { [RUN_ID_HEADER]: context.runId } : {}),
      },
      redirect: 'error',
    },
    fetch: observed.fetch,
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
    const payload: unknown = JSON.parse(text)
    return options.result ? options.result.parse(payload) : (payload as T)
  } catch (error) {
    if (error instanceof McpCommandError) throw error
    if (error instanceof StreamableHTTPError) {
      if (error.code === 404 && path !== '/mcp')
        throw new McpCommandError('This Engine version does not support the requested CLI command.')
      if (error.code === 401 || error.code === 403)
        throw new McpCommandError(
          agent
            ? 'Agent access requires a valid scoped token.'
            : 'The Engine rejected the credential.',
        )
    }
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
