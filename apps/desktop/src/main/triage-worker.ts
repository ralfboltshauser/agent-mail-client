import { ClaudeAuthError, triageWithGrant } from '@amc/cli/triage'
import type { TriageResult } from '../shared/api'

export type TriageWorkerRequest = { engineUrl: string; token: string; recent: boolean } | 'abort'

export type TriageWorkerReply = TriageResult | 'auth' | 'failed'

const port = process.parentPort
const controller = new AbortController()

port.on('message', ({ data }: { data: TriageWorkerRequest }) => {
  if (data === 'abort') {
    controller.abort()
    return
  }
  const { engineUrl, token, recent } = data
  const signal = AbortSignal.any([controller.signal, AbortSignal.timeout(120_000)])
  void triageWithGrant({ engineUrl, token }, false, recent, signal)
    .then((results): TriageWorkerReply => {
      const assigned = results.filter((result) => 'updated' in result && result.updated).length
      return { assigned, skipped: results.length - assigned }
    })
    .catch(
      (error: unknown): TriageWorkerReply => (error instanceof ClaudeAuthError ? 'auth' : 'failed'),
    )
    .then((reply) => port.postMessage(reply))
})
