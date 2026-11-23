import { Worker } from 'node:worker_threads'
import { newRunId } from '@amc/observability'
import type { Db } from '../../db/database.ts'
import { OperationStatus } from '../../db/diagnostics.ts'
import type { Logger } from '../../log.ts'
import { pendingPurgeEpoch } from './physical-purge.ts'

declare const AMC_PURGE_WORKER: string

class PurgeJobError extends Error {}

export function startPurgeMaintenance(
  db: Db,
  path: string,
  log: Logger,
  status = new OperationStatus(),
) {
  let worker: Worker | undefined
  let stopping = false
  const timer = setInterval(() => {
    if (worker) return
    const run = log.with({ runId: newRunId() })
    const start = performance.now()
    const reportFailure = (err: unknown) => {
      const count = status.failure(err)
      if (count)
        run.log('warn', 'purge.job.failed', {
          count,
          durationMs: performance.now() - start,
          err,
        })
    }
    try {
      const epoch = pendingPurgeEpoch(db)
      if (!epoch) return
      const bundled = typeof AMC_PURGE_WORKER === 'string'
      const entry = bundled ? AMC_PURGE_WORKER : new URL('./purge-worker.ts', import.meta.url)
      worker = new Worker(entry, { eval: bundled, workerData: { path, epoch } })
      let purged = false
      let failure: Error | undefined
      worker.once('message', (result) => {
        purged = result === 'purged'
      })
      worker.once('error', (err) => {
        failure = err
      })
      worker.once('exit', (code) => {
        worker = undefined
        if (stopping && code !== 0 && !failure) return
        if (!purged || code !== 0 || failure) {
          reportFailure(failure ?? new PurgeJobError())
          return
        }
        const { recovered, count } = status.success()
        run.log('info', 'purge.job.succeeded', {
          count: count || 1,
          durationMs: performance.now() - start,
          recovered,
        })
      })
    } catch (err) {
      reportFailure(err)
    }
  }, 2000)
  timer.unref()
  return async () => {
    stopping = true
    clearInterval(timer)
    await worker?.terminate()
  }
}
