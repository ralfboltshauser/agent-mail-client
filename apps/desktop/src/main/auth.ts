import { readFileSync, rmSync } from 'node:fs'
import { join } from 'node:path'
import { app } from 'electron'
import { archiveLegacyCredentials, credentialPath, writeCredentials } from './credential-files'

const file = () => credentialPath(app.getPath('userData'), 'pairing.json')

type LoadedPairing =
  | { state: 'paired'; engineUrl: string; token: string }
  | { state: 'unpaired' | 'read-error'; engineUrl: string | null }

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
  try {
    const stored = readPairing(file())
    if (stored) {
      if (typeof stored.token === 'string' && stored.token)
        return { state: 'paired', engineUrl: stored.engineUrl, token: stored.token }
      return { state: 'read-error', engineUrl: stored.engineUrl }
    }
    const archive = archiveLegacyCredentials(join(app.getPath('userData'), 'pairing.json'))
    // Reuse the replica when pairing again with the same Engine, even after a restart.
    const engineUrl = readPairing(archive)?.engineUrl ?? null
    return { state: 'unpaired', engineUrl }
  } catch {
    return { state: 'read-error', engineUrl: null }
  }
}

export function savePairing(engineUrl: string, token: string): void {
  writeCredentials(file(), { engineUrl, token })
}

export function clearPairing(): void {
  rmSync(file(), { force: true })
}
