import { ClaudeAuthError, runTriage } from '@amc/cli/triage'
import type { TriageResult } from '../shared/api'

export type TriageWorkerRequest = { engineUrl: string; token: string; accountId: string } | 'abort'

export type TriageWorkerReply = TriageResult | 'auth' | 'failed'

const port = process.parentPort
const controller = new AbortController()

port.on('message', ({ data }: { data: TriageWorkerRequest }) => {
  if (data === 'abort') {
    controller.abort()
    return
  }
  const { engineUrl, token, accountId } = data
  void runTriage({ engineUrl, token }, accountId, false, controller.signal)
    .then((results): TriageWorkerReply => {
      const assigned = results.filter((result) => 'updated' in result && result.updated).length
      return { assigned, skipped: results.length - assigned }
    })
    .catch(
      (error: unknown): TriageWorkerReply => (error instanceof ClaudeAuthError ? 'auth' : 'failed'),
    )
    .then((reply) => port.postMessage(reply))
})
