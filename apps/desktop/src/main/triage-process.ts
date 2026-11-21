import { execFile } from 'node:child_process'
import { join } from 'node:path'
import { withTriageGrant } from '@amc/cli/triage'
import { powerMonitor, utilityProcess } from 'electron'
import type { TriageResult } from '../shared/api'
import { TriageWorkerError } from './auto-triage'
import type { TriageWorkerReply, TriageWorkerRequest } from './triage-worker'

export function runTriageProcess(
  config: { engineUrl: string; token: string },
  accountId: string,
  recent: boolean,
  signal: AbortSignal,
  quitting: AbortSignal,
) {
  return withTriageGrant(
    config,
    accountId,
    false,
    AbortSignal.any([signal, quitting]),
    (grant) => runWorker({ ...grant, recent }, signal, quitting),
    3_000,
  ).catch((error: unknown) => {
    if (error instanceof TriageWorkerError || signal.aborted) throw error
    throw new TriageWorkerError('The Engine could not prepare or clean up triage.', {
      cause: error,
    })
  })
}

function runWorker(
  request: Exclude<TriageWorkerRequest, 'abort'>,
  signal: AbortSignal,
  quitting: AbortSignal,
): Promise<TriageResult> {
  signal.throwIfAborted()
  quitting.throwIfAborted()
  return new Promise((resolve, reject) => {
    const child = utilityProcess.fork(join(import.meta.dirname, 'triage-worker.js'), [], {
      serviceName: 'AMC Triage',
      stdio: 'ignore',
    })
    let reply: TriageWorkerReply | undefined
    const abort = () => child.postMessage('abort')
    const kill = () => child.kill()
    const timeout = setTimeout(kill, 180_000)
    quitting.addEventListener('abort', kill, { once: true })
    signal.addEventListener('abort', abort, { once: true })
    child.once('spawn', () => {
      if (signal.aborted || quitting.aborted) child.kill()
      else child.postMessage(request)
    })
    child.once('message', (message: TriageWorkerReply) => {
      reply = message
      child.kill()
    })
    child.once('exit', () => {
      clearTimeout(timeout)
      signal.removeEventListener('abort', abort)
      quitting.removeEventListener('abort', kill)
      if (signal.aborted) reject(signal.reason)
      else if (typeof reply === 'object') resolve(reply)
      else if (reply === 'auth')
        reject(new TriageWorkerError('Sign in to Claude Code with a Claude.ai subscription.'))
      else if (reply === 'failed')
        reject(new TriageWorkerError('Claude Code or the Engine could not complete triage.'))
      else reject(new TriageWorkerError('The triage process stopped before returning a result.'))
    })
  })
}

export async function onLowBattery(): Promise<boolean> {
  if (process.platform !== 'darwin' || !powerMonitor.isOnBatteryPower()) return false
  return new Promise((resolve) => {
    execFile('/usr/bin/pmset', ['-g', 'batt'], { timeout: 2_000 }, (error, stdout) => {
      const charge = stdout.match(/\b(\d+)%/)?.[1]
      resolve(!!error || charge === undefined || Number(charge) < 20)
    })
  })
}
