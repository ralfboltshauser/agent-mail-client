import { existsSync, readdirSync, rmSync, writeFileSync } from 'node:fs'
import { join } from 'node:path'
import { afterEach, describe, expect, it } from 'vitest'
import { tempDir } from '../test-support.ts'
import {
  backupDatabase,
  backupsToPrune,
  latestBackup,
  lockDatabaseFiles,
  restoreDatabase,
} from './backups.ts'
import { migrate, openDatabase, schemaVersion } from './database.ts'

const dirs: string[] = []

function fixture() {
  const dir = tempDir()
  dirs.push(dir)
  const path = join(dir, 'amc.db')
  const db = openDatabase(path)
  migrate(db)
  db.exec("INSERT INTO setting VALUES ('test', 'snapshot')")
  return { dir, path, db }
}

afterEach(() => {
  for (const dir of dirs.splice(0)) rmSync(dir, { recursive: true, force: true })
})

describe('backup retention', () => {
  it('keeps 14 daily copies and the newest copy in each of eight older UTC weeks', () => {
    const names = Array.from(
      { length: 90 },
      (_, day) =>
        `amc-${new Date(Date.UTC(2026, 0, 11 - day)).toISOString().slice(0, 10).replaceAll('-', '')}.db`,
    )
    const unrelated = ['pre-migrate-v6-123.db', 'amc.db', 'amc-20260110.db.tmp']
    const keep = [...names.slice(0, 14), ...[14, 21, 28, 35, 42, 49, 56, 63].map((i) => names[i])]
    const prune = backupsToPrune([...names].reverse().concat(unrelated))
    expect(names.filter((name) => !prune.includes(name))).toEqual(keep)
    expect(prune.some((name) => unrelated.includes(name))).toBe(false)
  })
})

describe('database snapshots', () => {
  it('publishes a private, consistent snapshot including committed WAL writes', () => {
    const { dir, path, db } = fixture()
    try {
      expect(existsSync(`${path}-wal`)).toBe(true)
      const target = backupDatabase(path, dir, new Date('2026-01-03T23:59:00Z'))
      expect(target).toBe(join(dir, 'amc-20260103.db'))
      expect(latestBackup(dir)).toEqual({ at: expect.any(Number), bytes: expect.any(Number) })
      const copy = openDatabase(target)
      try {
        expect(schemaVersion(copy)).toBe(schemaVersion(db))
        expect(copy.prepare("SELECT value FROM setting WHERE key = 'test'").get()?.value).toBe(
          'snapshot',
        )
        expect(copy.prepare('PRAGMA integrity_check').get()?.integrity_check).toBe('ok')
      } finally {
        copy.close()
      }
    } finally {
      db.close()
    }
  })

  it('refuses restore while the Engine owns the database and succeeds after it exits', () => {
    const { dir, path, db } = fixture()
    const backup = backupDatabase(path, dir)
    const running = lockDatabaseFiles(dir)
    try {
      db.exec("UPDATE setting SET value = 'live'")
      expect(() => restoreDatabase(backup, path)).toThrow('Database is in use')
      expect(db.prepare('SELECT value FROM setting').get()?.value).toBe('live')
    } finally {
      db.close()
      running.close()
    }
    const previous = restoreDatabase(backup, path)
    if (!previous) throw new Error('Expected a copy of the previous database')
    for (const [file, value] of [
      [path, 'snapshot'],
      [previous, 'live'],
    ] as const) {
      const copy = openDatabase(file)
      try {
        expect(copy.prepare('SELECT value FROM setting').get()?.value).toBe(value)
      } finally {
        copy.close()
      }
    }
  })

  it('keeps restored outbox sends for review without changing the backup', () => {
    const { dir, path, db } = fixture()
    db.exec(`
      INSERT INTO outbox (id, draft_id, account_id, revision, rfc_id, subject, to_json, send_at, undo_until, status, next_at)
      VALUES ('1', 'd1', 'a', 1, 'r1', 'queued', '[]', 0, 0, 'queued', 0),
             ('2', 'd2', 'a', 1, 'r2', 'dispatching', '[]', 0, 0, 'dispatching', 0),
             ('3', 'd3', 'a', 1, 'r3', 'sent', '[]', 0, 0, 'sent', 0);
    `)
    db.close()
    const backup = backupDatabase(path, dir)
    restoreDatabase(backup, path)
    for (const [file, expected] of [
      [path, ['uncertain', 'uncertain', 'sent']],
      [backup, ['queued', 'dispatching', 'sent']],
    ] as const) {
      const copy = openDatabase(file)
      try {
        expect(
          copy
            .prepare('SELECT status FROM outbox ORDER BY id')
            .all()
            .map((row) => row.status),
        ).toEqual(expected)
      } finally {
        copy.close()
      }
    }
  })

  it('preserves the existing nightly and live database when the input is corrupt', () => {
    const { dir, path, db } = fixture()
    db.close()
    const backup = backupDatabase(path, dir)
    const corrupt = join(dir, 'corrupt.db')
    writeFileSync(corrupt, 'broken SQLite data')
    expect(() => backupDatabase(corrupt, dir)).toThrow()
    expect(() => restoreDatabase(corrupt, path)).toThrow()
    expect(readdirSync(dir).filter((name) => name.startsWith('.snapshot-'))).toEqual([])
    for (const file of [backup, path]) {
      const copy = openDatabase(file)
      try {
        expect(copy.prepare('SELECT value FROM setting').get()?.value).toBe('snapshot')
      } finally {
        copy.close()
      }
    }
  })
})
