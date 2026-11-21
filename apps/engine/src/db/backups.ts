import {
  chmodSync,
  closeSync,
  existsSync,
  fsyncSync,
  linkSync,
  mkdtempSync,
  openSync,
  readdirSync,
  renameSync,
  rmSync,
  statSync,
} from 'node:fs'
import { dirname, join } from 'node:path'
import { DatabaseSync } from 'node:sqlite'
import { backupTo, type Db, schemaVersion } from './database.ts'
import { MIGRATIONS } from './migrations.ts'

const NIGHTLY = /^amc-\d{8}\.db$/
const DAY_MS = 86_400_000

function nightlyFiles(names: string[]) {
  return names
    .filter((name) => NIGHTLY.test(name))
    .sort()
    .reverse()
}

export function backupsToPrune(names: string[]): string[] {
  const weeks = new Set<number>()
  return nightlyFiles(names)
    .slice(14)
    .filter((name) => {
      const date = new Date(
        `${name.slice(4, 8)}-${name.slice(8, 10)}-${name.slice(10, 12)}T00:00:00Z`,
      )
      const monday = date.getTime() - ((date.getUTCDay() + 6) % 7) * DAY_MS
      if (weeks.size === 8 || weeks.has(monday)) return true
      weeks.add(monday)
      return false
    })
}

function listBackups(dir: string): string[] {
  try {
    return readdirSync(dir, { withFileTypes: true })
      .filter((entry) => entry.isFile())
      .map((entry) => entry.name)
  } catch (error) {
    if ((error as NodeJS.ErrnoException).code === 'ENOENT') return []
    throw error
  }
}

export function latestBackup(dir: string): { at: number; bytes: number } | null {
  for (const name of nightlyFiles(listBackups(dir))) {
    try {
      const stat = statSync(join(dir, name))
      return { at: Math.trunc(stat.mtimeMs), bytes: stat.size }
    } catch (error) {
      if ((error as NodeJS.ErrnoException).code !== 'ENOENT') throw error
    }
  }
  return null
}

/** Commands share a SQLite read lock. Restore needs exclusive access even during Engine startup. */
export function lockDatabaseFiles(dataDir: string, restoring = false): Db {
  const lock = new DatabaseSync(join(dataDir, '.database-lock'))
  try {
    lock.exec(restoring ? 'BEGIN EXCLUSIVE' : 'BEGIN; PRAGMA user_version')
    return lock
  } catch (error) {
    lock.close()
    if ((error as { errcode?: number }).errcode !== 5) throw error
    throw new Error(
      restoring
        ? 'Database is in use. Stop the Engine and wait for any database commands to finish.'
        : 'A database restore is in progress.',
      { cause: error },
    )
  }
}

function prepareSnapshot(path: string, restoring: boolean): void {
  const db = new DatabaseSync(path, { readOnly: !restoring })
  try {
    if (
      restoring &&
      db.prepare("SELECT 1 FROM sqlite_schema WHERE type = 'table' AND name = 'outbox'").get()
    ) {
      // Work in flight at backup time may have been sent or cancelled since then.
      db.exec(`UPDATE outbox SET status = 'uncertain',
        detail = 'Restored from backup. Check Sent before sending again.'
        WHERE status IN ('queued', 'dispatching')`)
    }
    const rows = db.prepare('PRAGMA integrity_check').all()
    if (rows.length !== 1 || rows[0]?.integrity_check !== 'ok') {
      throw new Error(`SQLite integrity check failed for ${path}`)
    }
    const version = schemaVersion(db)
    if (version < 1 || version > (MIGRATIONS.at(-1)?.version ?? 0)) {
      throw new Error(`Unsupported AMC database schema version ${version}`)
    }
    db.prepare('SELECT id FROM token LIMIT 1').get()
  } finally {
    db.close()
  }
}

function syncFile(path: string): void {
  const fd = openSync(path, 'r')
  try {
    fsyncSync(fd)
  } finally {
    closeSync(fd)
  }
}

function publishSnapshot(source: string, target: string, beforeRestoreSwap?: () => void): void {
  const dir = dirname(target)
  const stage = mkdtempSync(join(dir, '.snapshot-'))
  const snapshot = join(stage, 'amc.db')
  try {
    const db = new DatabaseSync(source, { readOnly: true })
    try {
      db.exec('PRAGMA busy_timeout = 5000')
      backupTo(db, snapshot)
    } finally {
      db.close()
    }
    prepareSnapshot(snapshot, beforeRestoreSwap !== undefined)
    chmodSync(snapshot, 0o600)
    syncFile(snapshot)
    beforeRestoreSwap?.()
    renameSync(snapshot, target)
    syncFile(dir)
  } finally {
    rmSync(stage, { recursive: true, force: true })
  }
}

export function backupDatabase(source: string, dir: string, now = new Date()): string {
  const date = now.toISOString().slice(0, 10).replaceAll('-', '')
  const target = join(dir, `amc-${date}.db`)
  publishSnapshot(source, target)
  for (const name of backupsToPrune(listBackups(dir))) rmSync(join(dir, name), { force: true })
  return target
}

export function restoreDatabase(source: string, target: string): string | null {
  const guard = lockDatabaseFiles(dirname(target), true)
  try {
    let previous: string | null = null
    publishSnapshot(source, target, () => {
      if (!existsSync(target)) {
        if (existsSync(`${target}-wal`) || existsSync(`${target}-shm`)) {
          throw new Error('Move the orphaned SQLite sidecars out of the database directory first.')
        }
        return
      }
      if (existsSync(`${target}-wal`) || existsSync(`${target}-shm`)) {
        // Checkpoint and remove sidecars through SQLite before changing the main file's inode.
        const current = new DatabaseSync(target)
        try {
          if (current.prepare('PRAGMA journal_mode = DELETE').get()?.journal_mode !== 'delete') {
            throw new Error('Cannot close the live database journal. Stop the Engine first.')
          }
        } finally {
          current.close()
        }
      }
      previous = `${target}.pre-restore-${Date.now()}`
      linkSync(target, previous)
    })
    return previous
  } finally {
    guard.close()
  }
}
