import {
  createLogger,
  type EventFields,
  isCorrelationId,
  newRequestId,
  type RunId,
  resolveLogLevel,
} from '@amc/observability'
import { currentRequestId } from '@amc/observability/hono'
import { stackFilePaths, stdoutSink } from '@amc/observability/node'
import type { McpServer, ToolCallback } from '@modelcontextprotocol/sdk/server/mcp.js'
import type { AnySchema, ZodRawShapeCompat } from '@modelcontextprotocol/sdk/server/zod-compat.js'
import type { CallToolResult } from '@modelcontextprotocol/sdk/types.js'

type Tool = EventFields<'mcp.tool.failed'>['tool']

const log = createLogger({
  component: 'mcp',
  level: resolveLogLevel(process.env.AMC_LOG_LEVEL),
  sink: stdoutSink,
  stackFiles: stackFilePaths([
    [new URL(import.meta.url), 'mcp/entry'],
    [new URL('./server.ts', import.meta.url), 'mcp/server'],
    [new URL('../src/mcp/server.ts', import.meta.url), 'mcp/server'],
  ]),
})

const rejectionErrors = new WeakMap<CallToolResult, Error>()
export function withToolError<T extends CallToolResult>(result: T, error: Error): T {
  rejectionErrors.set(result, error)
  return result
}

export function toolRegistration(server: McpServer, triageHolder?: string) {
  // Grant names are assigned by the owning Client. Copy only the internal UUID
  // from a triage holder, never the displayed token or device name.
  const id = triageHolder?.startsWith('triage-') ? triageHolder.slice('triage-'.length) : undefined
  const runId = isCorrelationId(id) ? (id as RunId) : undefined
  return <Input extends undefined | ZodRawShapeCompat | AnySchema = undefined>(
    tool: Tool,
    config: Parameters<typeof server.registerTool<AnySchema, Input>>[1],
    callback: ToolCallback<Input>,
  ) => {
    const invoke = callback as (
      ...args: Parameters<ToolCallback<Input>>
    ) => CallToolResult | Promise<CallToolResult>
    const observed = async (...args: Parameters<ToolCallback<Input>>) => {
      const requestId = currentRequestId() ?? newRequestId()
      try {
        const result = await invoke(...args)
        if (result.isError) {
          log.log(
            'warn',
            'mcp.tool.failed',
            {
              operation: 'engine-tool',
              tool,
              status: 'rejected',
              err: rejectionErrors.get(result) ?? new Error('MCP tool rejected the request'),
            },
            { requestId, runId },
          )
        }
        return result
      } catch (err) {
        log.log(
          'warn',
          'mcp.tool.failed',
          {
            operation: 'engine-tool',
            tool,
            status: 'failed',
            err,
          },
          { requestId, runId },
        )
        throw err
      }
    }
    return server.registerTool(tool, config, observed as ToolCallback<Input>)
  }
}
