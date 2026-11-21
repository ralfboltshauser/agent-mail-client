import { existsSync, readFileSync, rmSync, writeFileSync } from 'node:fs'
import { join } from 'node:path'
import { app, safeStorage } from 'electron'

interface Stored {
  engineUrl: string
  /** The owner-device token, encrypted with the macOS Keychain via safeStorage. */
  token: string
}

const file = () => join(app.getPath('userData'), 'pairing.json')

export function loadPairing(): { engineUrl: string; token: string } | null {
  if (!existsSync(file())) return null
  try {
    const stored = JSON.parse(readFileSync(file(), 'utf8')) as Stored
    return {
      engineUrl: stored.engineUrl,
      token: safeStorage.decryptString(Buffer.from(stored.token, 'base64')),
    }
  } catch {
    return null
  }
}

export function savePairing(engineUrl: string, token: string): void {
  if (!safeStorage.isEncryptionAvailable())
    throw new Error('macOS Keychain encryption is not available')
  const stored: Stored = { engineUrl, token: safeStorage.encryptString(token).toString('base64') }
  writeFileSync(file(), JSON.stringify(stored), { mode: 0o600 })
}

export function clearPairing(): void {
  rmSync(file(), { force: true })
}
