import {
  chmodSync,
  closeSync,
  existsSync,
  fsyncSync,
  linkSync,
  lstatSync,
  mkdtempSync,
  openSync,
  readdirSync,
  realpathSync,
  renameSync,
  rmSync,
} from 'node:fs'
import { dirname, join, resolve } from 'node:path'
import { DatabaseSync } from 'node:sqlite'
import { ERASURE_LEDGER_FILE, erasureLedgerId, openErasureLedger } from '../mail/triage/erasure.ts'
import { backupTo, type Db, migrate, openDatabase, schemaVersion } from './database.ts'
import { MIGRATIONS } from './migrations.ts'

const NIGHTLY = /^amc-\d{8}\.db$/
const DAY_MS = 86_400_000
let verifiedBackup: string | undefined

function nightlyDate(name: string): Date {
  return new Date(`${name.slice(4, 8)}-${name.slice(8, 10)}-${name.slice(10, 12)}T00:00:00Z`)
}

function nightlyFiles(names: string[]) {
  return names
    .filter((name) => {
      if (!NIGHTLY.test(name) || name.slice(4, 8) === '0000') return false
      // Date parsing can normalize out-of-range days into the following month.
      return nightlyDate(name).toJSON()?.slice(0, 10).replaceAll('-', '') === name.slice(4, 12)
    })
    .sort()
    .reverse()
}

export function backupsToPrune(names: string[]): string[] {
  const weeks = new Set<number>()
  return nightlyFiles(names)
    .slice(14)
    .filter((name) => {
      const date = nightlyDate(name)
      const monday = date.getTime() - ((date.getUTCDay() + 6) % 7) * DAY_MS
      if (weeks.size === 8 || weeks.has(monday)) return true
      weeks.add(monday)
      return false
    })
}

function listBackups(dir: string): string[] {
  try {
    return readdirSync(dir)
  } catch (error) {
    if ((error as NodeJS.ErrnoException).code === 'ENOENT') return []
    throw error
  }
}

function regularFile(path: string) {
  const stat = lstatSync(path, { throwIfNoEntry: false })
  return stat?.isFile() ? stat : undefined
}

export function latestBackup(dir: string): { at: number; bytes: number } | null {
  for (const name of nightlyFiles(listBackups(dir))) {
    const path = join(dir, name)
    const stat = regularFile(path)
    if (!stat) continue
    if (stat.size === 0) return null

    // Desktop polls health every minute. Recheck when the snapshot changes.
    const fingerprint = JSON.stringify([
      path,
      stat.dev,
      stat.ino,
      stat.size,
      stat.mtimeMs,
      stat.ctimeMs,
    ])
    if (fingerprint !== verifiedBackup) {
      try {
        prepareSnapshot(path, false)
      } catch {
        return null
      }
      verifiedBackup = fingerprint
    }
    return { at: Math.trunc(stat.mtimeMs), bytes: stat.size }
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
    if (beforeRestoreSwap) {
      const ledgerPath = join(dir, ERASURE_LEDGER_FILE)
      let expectedId: string | undefined
      if (existsSync(target)) {
        const live = new DatabaseSync(target, { readOnly: true })
        try {
          const known = erasureLedgerId(live)
          if (typeof known === 'string') expectedId = known
        } finally {
          live.close()
        }
      }
      const db = openDatabase(snapshot)
      try {
        if (expectedId || existsSync(ledgerPath) || schemaVersion(db) >= 24) {
          migrate(db)
          openErasureLedger(db, ledgerPath, expectedId)()
        }
      } finally {
        db.close()
      }
    }
    syncFile(snapshot)
    beforeRestoreSwap?.()
    renameSync(snapshot, target)
    syncFile(dir)
  } finally {
    rmSync(stage, { recursive: true, force: true })
  }
}

export function backupDatabase(source: string, dir: string, now = new Date()): string {
  const backupDir = resolve(dir)
  requireRealBackupDir(backupDir)
  const date = now.toISOString().slice(0, 10).replaceAll('-', '')
  const target = join(dir, `amc-${date}.db`)
  publishSnapshot(source, target)
  requireRealBackupDir(backupDir)
  const files = listBackups(backupDir).filter((name) => regularFile(join(backupDir, name)))
  for (const name of backupsToPrune(files)) rmSync(join(backupDir, name), { force: true })
  return target
}

function requireRealBackupDir(path: string): void {
  if (realpathSync(path) !== path || !lstatSync(path).isDirectory()) {
    throw new Error(`Backup directory must be a real directory at ${path}`)
  }
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
