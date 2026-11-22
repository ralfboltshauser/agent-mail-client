import { randomUUID } from 'node:crypto'
import { chmodSync, existsSync, mkdirSync, renameSync, rmSync, writeFileSync } from 'node:fs'
import { dirname, join } from 'node:path'

export function credentialPath(profile: string, name: string): string {
  return join(profile, 'credentials', name)
}

export function writeCredentials(path: string, data: object): void {
  const dir = dirname(path)
  mkdirSync(dir, { recursive: true, mode: 0o700 })
  chmodSync(dir, 0o700)
  const temp = `${path}.${randomUUID()}.tmp`
  try {
    writeFileSync(temp, `${JSON.stringify(data, null, 2)}\n`, {
      flag: 'wx',
      mode: 0o600,
    })
    chmodSync(temp, 0o600)
    renameSync(temp, path)
  } finally {
    rmSync(temp, { force: true })
  }
}

export function archiveLegacyCredentials(path: string): string {
  const archive = `${path}.legacy`
  if (existsSync(path)) {
    if (existsSync(archive)) renameSync(archive, `${archive}.${randomUUID()}`)
    renameSync(path, archive)
  }
  return archive
}
