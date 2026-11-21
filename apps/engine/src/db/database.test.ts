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

  it('upgrades a populated v7 database and preserves the v7 backup', () => {
    const dir = tempDir()
    const db = openDatabase(join(dir, 'mail.db'))
    try {
      expect(migrate(db, { migrations: MIGRATIONS.filter(({ version }) => version <= 7) })).toBe(7)
      expect(MIGRATIONS.filter(({ version }) => version > 7).map(({ version }) => version)).toEqual(
        [8, 9, 10, 11, 12, 13, 14, 15, 16],
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
        INSERT INTO account (id, kind, address, credentials, created_at)
        VALUES ('i', 'imap', 'imap@example.com', x'00', 0);
        INSERT INTO thread (id, account_id, provider_thread_id) VALUES ('i:t', 'i', 't');
        INSERT INTO message (id, account_id, thread_id, provider_id, sent_at, label_ids, body_text, body_search_limit)
        VALUES ('i:m', 'i', 'i:t', 'INBOX:1:2', 1, '["i:INBOX"]', 'visible hidden', 7);
        INSERT INTO imap_location (account_id, path_key, validity, uid, message_id, label_id, unread, starred, source_blob)
        VALUES ('i', 'INBOX', '1', 2, 'i:m', 'i:INBOX', 1, 1, 'fixture-source');
      `)
      const backupDir = join(dir, 'backups')
      expect(migrate(db, { backupDir })).toBe(16)
      expect(db.prepare('SELECT bucket FROM thread WHERE id = ?').get('a:t')).toEqual({
        bucket: null,
      })
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
      expect(db.prepare('SELECT uid, verified, source_blob FROM imap_location').get()).toEqual({
        uid: 2,
        verified: 1,
        source_blob: 'fixture-source',
      })
      expect(
        db.prepare("SELECT 1 FROM message_fts WHERE message_fts MATCH 'visible'").get(),
      ).toBeDefined()
      expect(
        db.prepare("SELECT 1 FROM message_fts WHERE message_fts MATCH 'hidden'").get(),
      ).toBeUndefined()
      expect(db.prepare("SELECT body_parts FROM message WHERE id = 'i:m'").get()).toEqual({
        body_parts: null,
      })
      expect(db.prepare('SELECT subject FROM draft').get()).toEqual({ subject: 'Existing draft' })
      db.exec(`
        INSERT INTO mutation (id, principal, account_id, thread_id, request, status)
        VALUES ('mutation', 'owner', 'a', 'a:t', '{}', 'partial');
      `)
      const [backupFile] = readdirSync(backupDir)
      if (!backupFile) throw new Error('Missing migration backup')
      const backup = openDatabase(join(backupDir, backupFile))
      try {
        expect(schemaVersion(backup)).toBe(7)
        expect(backup.prepare('SELECT count(*) AS n FROM message').get()).toEqual({ n: 10001 })
        expect(backup.prepare('SELECT uid FROM imap_location').get()).toEqual({ uid: 2 })
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

  it('upgrades legacy Organise v8 and rejects a different migration at the same version', () => {
    const db = openDatabase(':memory:')
    const compose = MIGRATIONS.find(({ version }) => version === 9)
    if (!compose) throw new Error('Compose migration missing')
    expect(migrate(db, { migrations: MIGRATIONS.filter(({ version }) => version <= 8) })).toBe(8)
    db.exec('DROP TABLE schema_migration')
    expect(migrate(db)).toBe(16)
    expect(db.prepare('SELECT * FROM organise_intent').all()).toEqual([])
    expect(db.prepare('SELECT * FROM outbox').all()).toEqual([])

    const wrong = openDatabase(':memory:')
    migrate(wrong, {
      migrations: [...MIGRATIONS.filter(({ version }) => version <= 7), { ...compose, version: 8 }],
    })
    db.close()
    expect(() => migrate(wrong)).toThrow(/Schema migration v8 mismatch.*organise/)
    wrong.exec('DROP TABLE schema_migration')
    expect(() => migrate(wrong)).toThrow(/Schema migration v8 mismatch.*organise/)
    wrong.close()
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
