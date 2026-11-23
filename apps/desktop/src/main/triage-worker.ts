import { describeTriageFailure, TriageFailure, triageWithGrant } from '@amc/cli/triage'
import { isCorrelationId, type RunId } from '@amc/observability'
import type { TriageResult } from '../shared/api'

export type TriageWorkerRequest =
  | { engineUrl: string; token: string; recent: boolean; runId: RunId }
  | 'abort'

export type TriageWorkerReply = { runId: RunId } & (
  | TriageResult
  | { failure: Omit<ReturnType<typeof describeTriageFailure>, 'message'> }
)

const port = process.parentPort
const controller = new AbortController()

port.on('message', ({ data }: { data: TriageWorkerRequest }) => {
  if (data === 'abort') {
    controller.abort()
    return
  }
  const { engineUrl, token, recent, runId } = data
  if (!isCorrelationId(runId)) return
  const deadline = AbortSignal.timeout(120_000)
  const signal = AbortSignal.any([controller.signal, deadline])
  void triageWithGrant({ engineUrl, token }, false, recent, signal)
    .then((results): TriageWorkerReply => {
      const assigned = results.filter((result) => 'updated' in result && result.updated).length
      return { runId, assigned, skipped: results.length - assigned }
    })
    .catch((error: unknown): TriageWorkerReply => {
      const { reason, className } = describeTriageFailure(
        deadline.aborted && !(error instanceof TriageFailure)
          ? new TriageFailure('timeout', { cause: deadline.reason })
          : error,
      )
      return { runId, failure: { reason, className } }
    })
    .then((reply) => port.postMessage(reply))
})
