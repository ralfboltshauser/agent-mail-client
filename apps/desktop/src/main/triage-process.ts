import { execFile } from 'node:child_process'
import { join } from 'node:path'
import { powerMonitor, utilityProcess } from 'electron'
import type { TriageResult } from '../shared/api'
import { TriageWorkerError } from './auto-triage'
import type { TriageWorkerReply, TriageWorkerRequest } from './triage-worker'

export function runTriageProcess(
  request: Exclude<TriageWorkerRequest, 'abort'>,
  signal: AbortSignal,
): Promise<TriageResult> {
  signal.throwIfAborted()
  return new Promise((resolve, reject) => {
    const child = utilityProcess.fork(join(import.meta.dirname, 'triage-worker.js'), [], {
      serviceName: 'AMC Triage',
      stdio: 'ignore',
    })
    let reply: TriageWorkerReply | undefined
    const abort = () => child.postMessage('abort')
    const timeout = setTimeout(() => child.kill(), 180_000)
    signal.addEventListener('abort', abort, { once: true })
    child.once('spawn', () => {
      if (signal.aborted) child.kill()
      else child.postMessage(request)
    })
    child.once('message', (message: TriageWorkerReply) => {
      reply = message
      // The shared triage code has finished revoking its grant before replying.
      child.kill()
    })
    child.once('exit', () => {
      clearTimeout(timeout)
      signal.removeEventListener('abort', abort)
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
      resolve(!error && charge !== undefined && Number(charge) < 20)
    })
  })
}
