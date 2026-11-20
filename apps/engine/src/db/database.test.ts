import { existsSync, readdirSync } from 'node:fs'
import { join } from 'node:path'
import { describe, expect, it } from 'vitest'
import { tempDir } from '../test-support.ts'
import { migrate, openDatabase, schemaVersion, transaction } from './database.ts'
import { MIGRATIONS } from './migrations.ts'

describe('migrate', () => {
  it('brings a new database to the latest version and is idempotent', () => {
    const db = openDatabase(':memory:')
    const latest = Math.max(...MIGRATIONS.map((m) => m.version))
    expect(migrate(db)).toBe(latest)
    expect(migrate(db)).toBe(latest)
    expect(schemaVersion(db)).toBe(latest)
  })

  it('backs up an existing database before applying new migrations', () => {
    const dir = tempDir()
    const db = openDatabase(join(dir, 'amc.db'))
    migrate(db, { migrations: [{ version: 1, name: 'one', sql: 'CREATE TABLE a (x INTEGER)' }] })
    const backupDir = join(dir, 'backups')
    migrate(db, {
      backupDir,
      migrations: [
        { version: 1, name: 'one', sql: 'CREATE TABLE a (x INTEGER)' },
        { version: 2, name: 'two', sql: 'CREATE TABLE b (y INTEGER)' },
      ],
    })
    expect(schemaVersion(db)).toBe(2)
    expect(existsSync(backupDir)).toBe(true)
    expect(readdirSync(backupDir)).toHaveLength(1)
  })

  it('leaves the version unchanged when a migration fails', () => {
    const db = openDatabase(':memory:')
    expect(() =>
      migrate(db, { migrations: [{ version: 1, name: 'bad', sql: 'CREATE TABLE (' }] }),
    ).toThrow()
    expect(schemaVersion(db)).toBe(0)
  })
})

describe('transaction', () => {
  it('rolls back on error', () => {
    const db = openDatabase(':memory:')
    db.exec('CREATE TABLE t (x INTEGER)')
    expect(() =>
      transaction(db, () => {
        db.exec('INSERT INTO t VALUES (1)')
        throw new Error('boom')
      }),
    ).toThrow('boom')
    expect(db.prepare('SELECT count(*) AS n FROM t').get()).toEqual({ n: 0 })
  })
})
