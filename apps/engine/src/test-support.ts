import { mkdtempSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import type { Config } from './config.ts'
import { type Db, migrate, openDatabase } from './db/database.ts'
import { createLogger } from './log.ts'

export function tempDir(): string {
  return mkdtempSync(join(tmpdir(), 'amc-test-'))
}

export function testDb(): Db {
  const db = openDatabase(':memory:')
  migrate(db)
  return db
}

export function testConfig(overrides: Partial<Config> = {}): Config {
  const dir = tempDir()
  return {
    listen: { host: '127.0.0.1', port: 0 },
    dataDir: dir,
    blobDir: dir,
    secretsDir: dir,
    backupDir: join(dir, 'backups'),
    allowedTailscaleLogins: [],
    logLevel: 'error',
    ...overrides,
  }
}

export const silentLog = createLogger('silent')
