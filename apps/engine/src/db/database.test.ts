import { existsSync, readdirSync, rmSync } from 'node:fs'
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

  it('upgrades a populated v3 database in one migration and preserves the v3 backup', () => {
    const dir = tempDir()
    const db = openDatabase(join(dir, 'mail.db'))
    try {
      expect(migrate(db, { migrations: MIGRATIONS.filter(({ version }) => version <= 3) })).toBe(3)
      expect(MIGRATIONS.filter(({ version }) => version > 3).map(({ version }) => version)).toEqual(
        [4],
      )
      db.exec(`
        INSERT INTO account (id, kind, address, credentials, created_at)
        VALUES ('a', 'gmail', 'fixture@example.com', x'00', 0);
        INSERT INTO thread (id, account_id, provider_thread_id) VALUES ('a:t', 'a', 't');
        WITH RECURSIVE seq(i) AS (SELECT 1 UNION ALL SELECT i + 1 FROM seq WHERE i < 10000)
        INSERT INTO message (id, account_id, thread_id, provider_id, sent_at, label_ids, body_text)
        SELECT 'a:' || i, 'a', 'a:t', i, i, '["a:INBOX"]', 'fixturetext' FROM seq;
        INSERT INTO draft (id, account_id, thread_id, subject, last_author, created_at, updated_at)
        VALUES ('draft', 'a', 'a:t', 'Existing draft', 'owner', 0, 0);
      `)
      const backupDir = join(dir, 'backups')
      expect(migrate(db, { backupDir })).toBe(4)
      expect(db.prepare('PRAGMA integrity_check').get()).toEqual({ integrity_check: 'ok' })
      expect(db.prepare('PRAGMA foreign_key_check').all()).toEqual([])
      expect(
        db
          .prepare("SELECT count(*) AS n FROM message_fts WHERE message_fts MATCH 'fixturetext'")
          .get(),
      ).toEqual({ n: 10000 })
      expect(
        db
          .prepare(`SELECT count(*) AS n FROM message WHERE label_ids = '["a:INBOX"]'
        AND provider_label_ids IS NULL AND provider_history_id IS NULL
        AND provider_delivery_history_id IS NULL`)
          .get(),
      ).toEqual({ n: 10000 })
      expect(db.prepare('SELECT subject FROM draft').get()).toEqual({ subject: 'Existing draft' })
      db.exec(`
        INSERT INTO mutation (id, principal, account_id, thread_id, request, status)
        VALUES ('mutation', 'owner', 'a', 'a:t', '{}', 'partial');
      `)
      const [backupFile] = readdirSync(backupDir)
      if (!backupFile) throw new Error('Missing migration backup')
      const backup = openDatabase(join(backupDir, backupFile))
      try {
        expect(schemaVersion(backup)).toBe(3)
        expect(backup.prepare('SELECT count(*) AS n FROM message').get()).toEqual({ n: 10000 })
        expect(backup.prepare('SELECT subject FROM draft').get()).toEqual({
          subject: 'Existing draft',
        })
      } finally {
        backup.close()
      }
    } finally {
      db.close()
      rmSync(dir, { recursive: true, force: true })
    }
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
