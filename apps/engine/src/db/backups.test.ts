import {
  existsSync,
  lstatSync,
  mkdirSync,
  readdirSync,
  realpathSync,
  rmSync,
  symlinkSync,
  truncateSync,
  writeFileSync,
} from 'node:fs'
import { join } from 'node:path'
import { doctorWarnings } from '@amc/protocol'
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
  const dir = realpathSync(tempDir())
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

  it('admits real UTC calendar dates only, including leap days', () => {
    const recent = Array.from(
      { length: 14 },
      (_, day) => `amc-202603${String(day + 1).padStart(2, '0')}.db`,
    )
    const older = Array.from({ length: 8 }, (_, week) => {
      const date = new Date(Date.UTC(2026, 1, 28 - 7 * week))
      return `amc-${date.toISOString().slice(0, 10).replaceAll('-', '')}.db`
    })
    const invalid = ['amc-20250229.db', 'amc-20250431.db', 'amc-20251340.db', 'amc-20250010.db']
    expect(backupsToPrune([...recent, ...older, ...invalid, 'amc-20240229.db'])).toEqual([
      'amc-20240229.db',
    ])
  })

  it('rejects a symlinked backup directory or a symlink in its parent path', () => {
    const { dir, path, db } = fixture()
    db.close()
    const outside = join(dir, 'outside')
    const alias = join(dir, 'alias')
    mkdirSync(outside)
    mkdirSync(join(outside, 'child'))
    symlinkSync(outside, alias)
    const before = readdirSync(outside)
    for (const backupDir of [alias, join(alias, 'child')]) {
      expect(() => backupDatabase(path, backupDir)).toThrow('Backup directory')
    }
    expect(readdirSync(outside)).toEqual(before)
    expect(readdirSync(join(outside, 'child'))).toEqual([])
  })

  it('prunes only regular files directly inside the backup directory', () => {
    const { dir, path, db } = fixture()
    db.close()
    for (let day = 1; day <= 22; day++) {
      const date = new Date(Date.UTC(2026, 2, 30 - day * 7))
      writeFileSync(join(dir, `amc-${date.toISOString().slice(0, 10).replaceAll('-', '')}.db`), '')
    }
    const old = join(dir, 'amc-20240101.db')
    const link = join(dir, 'amc-20240102.db')
    const subdir = join(dir, 'amc-20240103.db')
    writeFileSync(old, '')
    symlinkSync(path, link)
    mkdirSync(subdir)
    backupDatabase(path, dir, new Date('2026-03-30'))
    expect(existsSync(old)).toBe(false)
    expect(lstatSync(link).isSymbolicLink()).toBe(true)
    expect(lstatSync(subdir).isDirectory()).toBe(true)
    expect(existsSync(path)).toBe(true)
  })
})

describe('database snapshots', () => {
  it.each([
    ['empty', 0],
    ['corrupt', 4096],
  ] as const)('warns when the newest nightly is %s', (_label, size) => {
    const { dir, path, db } = fixture()
    db.close()
    backupDatabase(path, dir, new Date('2026-01-02'))
    const newest = backupDatabase(path, dir, new Date('2026-01-03'))
    expect(latestBackup(dir)).not.toBeNull()
    truncateSync(newest, size)
    const lastBackup = latestBackup(dir)
    expect(lastBackup).toBeNull()
    expect(doctorWarnings({ lastBackup, disks: [] })).toEqual(['No valid nightly backup found.'])
  })

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
