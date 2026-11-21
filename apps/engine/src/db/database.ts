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
  const hasTable = (name: string) =>
    db.prepare("SELECT 1 FROM sqlite_schema WHERE type = 'table' AND name = ?").get(name)
  const applied = hasTable('schema_migration')
    ? (db.prepare('SELECT version, name FROM schema_migration').all() as {
        version: number
        name: string
      }[])
    : []
  if (
    current >= 8 &&
    !applied.some(({ version }) => version === 8) &&
    (hasTable('outbox') || hasTable('organise_intent'))
  ) {
    applied.push({
      version: 8,
      name: hasTable('organise_intent') ? 'organise' : 'Compose documents and durable outbox',
    })
  }
  for (const { version, name } of applied) {
    const expected = migrations.find((migration) => migration.version === version)
    if (expected && expected.name !== name)
      throw new Error(
        `Schema migration v${version} mismatch: database has "${name}", code expects "${expected.name}"`,
      )
  }
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
      db.exec(
        'CREATE TABLE IF NOT EXISTS schema_migration (version INTEGER PRIMARY KEY, name TEXT NOT NULL) STRICT',
      )
      db.exec(migration.sql)
      db.prepare('INSERT INTO schema_migration VALUES (?, ?)').run(
        migration.version,
        migration.name,
      )
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
