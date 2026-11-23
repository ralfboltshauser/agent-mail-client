import { Worker } from 'node:worker_threads'
import type { Db } from '../../db/database.ts'
import type { Logger } from '../../log.ts'
import { pendingPurgeEpoch } from './physical-purge.ts'

declare const AMC_PURGE_WORKER: string

export function startPurgeMaintenance(db: Db, path: string, log: Logger) {
  let worker: Worker | undefined
  const reportFailure = () => log.warn('Owner erasure purge failed and will retry')
  const timer = setInterval(() => {
    if (worker) return
    try {
      const epoch = pendingPurgeEpoch(db)
      if (!epoch) return
      const bundled = typeof AMC_PURGE_WORKER === 'string'
      const entry = bundled ? AMC_PURGE_WORKER : new URL('./purge-worker.ts', import.meta.url)
      worker = new Worker(entry, { eval: bundled, workerData: { path, epoch } })
      worker.once('error', reportFailure)
      worker.once('exit', () => {
        worker = undefined
      })
    } catch {
      reportFailure()
    }
  }, 2000)
  timer.unref()
  return async () => {
    clearInterval(timer)
    await worker?.terminate()
  }
}
