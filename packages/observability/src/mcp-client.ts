import { AsyncLocalStorage } from 'node:async_hooks'
import type { EventFields } from './events.ts'
import { fetchWithRequestId, newRequestId, type RequestId, type RunId } from './ids.ts'
import type { Logger } from './index.ts'

type Failure = EventFields<'mcp.tool.failed'>

interface Exchange {
  requestId: RequestId
  status?: Failure['status']
  err?: unknown
}

export function mcpClientObservability(getLog: () => Logger, onRequest?: (id: RequestId) => void) {
  const scope = new AsyncLocalStorage<Exchange>()
  const fetch: typeof globalThis.fetch = async (input, init) => {
    const requestId = newRequestId()
    const call = scope.getStore()
    if (call) {
      call.requestId = requestId
      call.err = undefined
      call.status = undefined
      onRequest?.(requestId)
    }
    try {
      const result = await fetchWithRequestId(input, init, requestId)
      // The SDK handles an optional SSE rejection and OAuth challenges.
      // Only record the exchange if the calling operation ultimately fails.
      if (call && !result.ok) call.status = result.status >= 500 ? 'failed' : 'rejected'
      return result
    } catch (err) {
      if (call) {
        call.status = 'unavailable'
        call.err = err
      }
      throw err
    }
  }

  async function call<T>(
    tool: Failure['tool'],
    runId: RunId | undefined,
    action: () => Promise<T>,
    isError?: (result: T) => boolean,
  ) {
    const current: Exchange = { requestId: newRequestId() }
    function log(status: Failure['status'], err: unknown) {
      getLog().log(
        'warn',
        'mcp.tool.failed',
        { operation: 'engine-client', tool, status, err },
        {
          requestId: current.requestId,
          runId,
        },
      )
    }
    try {
      const result = await scope.run(current, action)
      if (isError?.(result)) log('rejected', new Error('MCP tool rejected the request'))
      return { result, requestId: current.requestId }
    } catch (error) {
      log(current.status ?? 'failed', current.err ?? error)
      throw error
    }
  }

  return { fetch, call }
}
