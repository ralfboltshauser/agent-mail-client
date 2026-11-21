import { mkdirSync, statSync } from 'node:fs'
import { join } from 'node:path'
import { DatabaseSync } from 'node:sqlite'
import type { Logger } from '../log.ts'
import { MIGRATIONS, type Migration } from './migrations.ts'

export type Db = DatabaseSync

export function openDatabase(path: string): Db {
  const db = new DatabaseSync(path)
  db.exec(`
    PRAGMA journal_mode = WAL;
    PRAGMA synchronous = NORMAL;
    PRAGMA foreign_keys = ON;
    PRAGMA busy_timeout = 5000;
  `)
  return db
}

export function schemaVersion(db: Db): number {
  const row = db.prepare('PRAGMA user_version').get() as { user_version: number }
  return row.user_version
}

/** Runs `fn` in an IMMEDIATE transaction (or a nested savepoint) and commits, or rolls back on any error. */
export function transaction<T>(db: Db, fn: () => T): T {
  const nested = db.isTransaction
  db.exec(nested ? 'SAVEPOINT mail_transaction' : 'BEGIN IMMEDIATE')
  try {
    const result = fn()
    db.exec(nested ? 'RELEASE mail_transaction' : 'COMMIT')
    return result
  } catch (error) {
    if (nested) {
      db.exec('ROLLBACK TO mail_transaction')
      db.exec('RELEASE mail_transaction')
    } else db.exec('ROLLBACK')
    throw error
  }
}

/** Writes a consistent copy of the database to `targetPath` (works while the Engine runs). */
export function backupTo(db: Db, targetPath: string): void {
  db.prepare('VACUUM INTO ?').run(targetPath)
}

/**
 * Applies pending migrations, each in its own transaction. When the database already holds
 * data, a backup is written to `backupDir` first so a bad migration can be undone by hand.
 */
export function migrate(
  db: Db,
  options: { backupDir?: string; log?: Logger; migrations?: readonly Migration[] } = {},
): number {
  const migrations = options.migrations ?? MIGRATIONS
  const current = schemaVersion(db)
  const pending = migrations
    .filter((m) => m.version > current)
    .sort((a, b) => a.version - b.version)
  if (pending.length === 0) return current

  if (current > 0 && options.backupDir) {
    mkdirSync(options.backupDir, { recursive: true })
    const target = join(options.backupDir, `pre-migrate-v${current}-${Date.now()}.db`)
    backupTo(db, target)
    options.log?.info({ target }, 'backed up database before migrating')
  }

  for (const migration of pending) {
    transaction(db, () => {
      db.exec(migration.sql)
      db.exec(`PRAGMA user_version = ${migration.version}`)
    })
    options.log?.info({ version: migration.version, name: migration.name }, 'applied migration')
  }
  return schemaVersion(db)
}

export function fileSize(path: string): number {
  try {
    return statSync(path).size
  } catch {
    return 0
  }
}
