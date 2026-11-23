import { execFile } from 'node:child_process'
import { join } from 'node:path'
import { TriageFailure, withTriageGrant } from '@amc/cli/triage'
import { newRunId } from '@amc/observability'
import { powerMonitor, utilityProcess } from 'electron'
import type { TriageResult } from '../shared/api'
import { mainLog, operationFailure } from './observability'
import type { TriageWorkerReply, TriageWorkerRequest } from './triage-worker'

export function runTriageProcess(
  config: { engineUrl: string; token: string },
  accountId: string,
  recent: boolean,
  signal: AbortSignal,
  quitting: AbortSignal,
  runId = newRunId(),
) {
  return withTriageGrant(
    config,
    accountId,
    false,
    AbortSignal.any([signal, quitting]),
    (grant) => runWorker({ ...grant, recent, runId }, signal, quitting),
    3_000,
  )
}

function runWorker(
  request: Exclude<TriageWorkerRequest, 'abort'>,
  signal: AbortSignal,
  quitting: AbortSignal,
): Promise<TriageResult> {
  signal.throwIfAborted()
  quitting.throwIfAborted()
  const { runId } = request
  const log = mainLog.with({ runId })
  log.log('debug', 'desktop.operation.started', { stage: 'triage-worker' })
  return new Promise<TriageResult>((resolve, reject) => {
    let child: ReturnType<typeof utilityProcess.fork>
    try {
      child = utilityProcess.fork(join(import.meta.dirname, 'triage-worker.js'), [], {
        serviceName: 'AMC Triage',
        stdio: 'ignore',
      })
    } catch (error) {
      reject(new TriageFailure('worker-start', { cause: error }))
      return
    }
    let reply: TriageWorkerReply | undefined
    const abort = () => child.postMessage('abort')
    const kill = () => child.kill()
    let timedOut = false
    let spawned = false
    const timeout = setTimeout(() => {
      timedOut = true
      kill()
    }, 180_000)
    quitting.addEventListener('abort', kill, { once: true })
    signal.addEventListener('abort', abort, { once: true })
    child.once('spawn', () => {
      spawned = true
      if (signal.aborted || quitting.aborted) child.kill()
      else child.postMessage(request)
    })
    child.once('message', (message: TriageWorkerReply) => {
      if (message.runId === runId) reply = message
      child.kill()
    })
    child.once('exit', () => {
      clearTimeout(timeout)
      signal.removeEventListener('abort', abort)
      quitting.removeEventListener('abort', kill)
      if (signal.aborted || quitting.aborted) reject(new TriageFailure('interrupted'))
      else if (reply && 'failure' in reply) {
        const cause = new Error()
        cause.name = reply.failure.className
        reject(new TriageFailure(reply.failure.reason, { cause }))
      } else if (reply) resolve({ assigned: reply.assigned, skipped: reply.skipped })
      else if (timedOut) reject(new TriageFailure('timeout'))
      else reject(new TriageFailure(spawned ? 'worker-exit' : 'worker-start'))
    })
  }).then(
    (value) => {
      log.log('debug', 'desktop.operation.finished', { stage: 'triage-worker' })
      return value
    },
    (err: unknown) => {
      log.log('error', 'desktop.operation.failed', { stage: 'triage-worker', err })
      throw err
    },
  )
}

export async function onLowBattery(): Promise<boolean> {
  if (process.platform !== 'darwin' || !powerMonitor.isOnBatteryPower()) return false
  return new Promise((resolve) => {
    execFile('/usr/bin/pmset', ['-g', 'batt'], { timeout: 2_000 }, (error, stdout) => {
      const charge = stdout.match(/\b(\d+)%/)?.[1]
      if (error) operationFailure('battery', error)
      else if (charge === undefined)
        operationFailure('battery', new Error('Battery reading unavailable'))
      resolve(!!error || charge === undefined || Number(charge) < 20)
    })
  })
}
