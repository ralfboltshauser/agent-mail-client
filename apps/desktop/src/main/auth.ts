import { readFileSync, rmSync } from 'node:fs'
import { join } from 'node:path'
import { app } from 'electron'
import type { FailureDetails } from '../shared/failure'
import { archiveLegacyCredentials, credentialPath, writeCredentials } from './credential-files'
import { failureScope, mainLog, operationFailure } from './observability'

const file = () => credentialPath(app.getPath('userData'), 'pairing.json')

type LoadedPairing =
  | { state: 'paired'; engineUrl: string; token: string }
  | { state: 'unpaired'; engineUrl: string | null }
  | { state: 'read-error'; engineUrl: string | null; failure: FailureDetails }

let readFailure: FailureDetails | undefined

function readPairing(path: string): { engineUrl: string; token?: unknown } | null {
  let data: string
  try {
    data = readFileSync(path, 'utf8')
  } catch (error) {
    if ((error as NodeJS.ErrnoException).code === 'ENOENT') return null
    throw error
  }
  const { engineUrl, token } = JSON.parse(data)
  return { engineUrl: new URL(engineUrl).origin, token }
}

export function loadPairing(): LoadedPairing {
  let engineUrl: string | null = null
  try {
    const stored = readPairing(file())
    if (stored) {
      engineUrl = stored.engineUrl
      if (typeof stored.token !== 'string' || !stored.token) throw new TypeError('Invalid pairing')
      if (readFailure) {
        mainLog.log(
          'info',
          'desktop.operation.finished',
          { stage: 'pairing-read' },
          failureScope(readFailure),
        )
        readFailure = undefined
      }
      return { state: 'paired', engineUrl, token: stored.token }
    }
    const archive = archiveLegacyCredentials(join(app.getPath('userData'), 'pairing.json'))
    // Reuse the replica when pairing again with the same Engine, even after a restart.
    engineUrl = readPairing(archive)?.engineUrl ?? null
    return { state: 'unpaired', engineUrl }
  } catch (error) {
    readFailure = operationFailure('pairing-read', error)
    return { state: 'read-error', engineUrl, failure: readFailure }
  }
}

export function savePairing(engineUrl: string, token: string): void {
  try {
    writeCredentials(file(), { engineUrl, token })
  } catch (error) {
    operationFailure('pairing-write', error)
    throw error
  }
}

export function clearPairing(): void {
  try {
    rmSync(file(), { force: true })
  } catch (error) {
    operationFailure('pairing-clear', error)
    throw error
  }
}
