import { existsSync, readdirSync, rmSync } from 'node:fs'
import { join } from 'node:path'
import { describe, expect, it } from 'vitest'
import { tempDir } from '../test-support.ts'
import { migrate, openDatabase, schemaVersion, transaction } from './database.ts'
import { MIGRATIONS } from './migrations.ts'

const latest = Math.max(...MIGRATIONS.map(({ version }) => version))

describe('migrate', () => {
  it('brings a new database to the latest version and is idempotent', () => {
    const db = openDatabase(':memory:')
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
        [8, 9, 10, 11, 12, 13, 14, 15, 16, 17, 18, 19, 20, 21],
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
      expect(migrate(db, { backupDir })).toBe(latest)
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
      expect(db.prepare('SELECT subject, mirror_written_hash FROM draft').get()).toEqual({
        subject: 'Existing draft',
        mirror_written_hash: null,
      })
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
    expect(migrate(db)).toBe(latest)
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

  it('preserves queued Gmail draft removals and disarms legacy IMAP removals', () => {
    const db = openDatabase(':memory:')
    try {
      migrate(db, { migrations: MIGRATIONS.filter(({ version }) => version <= 18) })
      db.exec(`
        INSERT INTO account (id, kind, address, credentials, created_at)
        VALUES ('g', 'gmail', 'gmail@example.test', x'00', 0),
               ('i', 'imap', 'imap@example.test', x'00', 0);
        INSERT INTO draft_mirror_removal (account_id, provider_draft_id, mirror_hash, draft_id)
        VALUES ('g', 'gmail-draft', 'gmail-hash', 'draft'),
               ('i', 'imap-draft', 'imap-hash', 'draft');
      `)
      expect(migrate(db, { migrations: MIGRATIONS.filter(({ version }) => version <= 19) })).toBe(
        19,
      )
      expect(
        db
          .prepare('SELECT account_id, mirror_hash FROM draft_mirror_removal ORDER BY account_id')
          .all(),
      ).toEqual([
        { account_id: 'g', mirror_hash: 'gmail-hash' },
        { account_id: 'i', mirror_hash: null },
      ])
      expect(migrate(db)).toBe(latest)
    } finally {
      db.close()
    }
  })

  it('retires marker-based Snooze and restores provider labels in the replica', () => {
    const db = openDatabase(':memory:')
    try {
      migrate(db, { migrations: MIGRATIONS.filter(({ version }) => version <= 16) })
      db.exec(`
        INSERT INTO account (id, kind, address, credentials, created_at)
        VALUES ('a', 'gmail', 'fixture@example.com', x'00', 0);
        INSERT INTO thread (id, account_id, provider_thread_id, snoozed_until, organise_state)
        VALUES ('a:t', 'a', 't', 9000, '{"snoozeIntent":"old","snoozedUntil":9000}');
        INSERT INTO message (id, account_id, thread_id, provider_id, sent_at, label_ids, provider_label_ids)
        VALUES ('a:m1', 'a', 'a:t', 'm1', 1, '["a:AMC/Snoozed"]', '["a:INBOX"]'),
               ('a:m2', 'a', 'a:t', 'm2', 2, '[]', '["a:AMC/Snoozed"]');
        INSERT INTO organise_intent (id, account_id, history_id, checked_history_id, marker_id)
        VALUES ('old', 'a', '1', '1', 'Label_existing');
        INSERT INTO mutation (id, principal, account_id, thread_id, request, next_attempt, state_patch)
        VALUES ('old', 'owner', 'a', 'a:t', '{"kind":"snooze"}', 9000, '{"snoozedUntil":9000}'),
               ('later', 'owner', 'a', 'a:t', '{"kind":"star"}', 0, '{"snoozeIntent":null}');
        INSERT INTO mutation_message (mutation_id, message_id, patch, before)
        VALUES ('old', 'a:m1', '{"a:INBOX":false,"a:AMC/Snoozed":true}', '{"a:INBOX":true}');
      `)
      expect(migrate(db)).toBe(latest)
      expect(db.prepare('SELECT label_ids FROM message ORDER BY id').all()).toEqual([
        { label_ids: '["a:INBOX"]' },
        { label_ids: '["a:AMC/Snoozed"]' },
      ])
      expect(
        db.prepare('SELECT snoozed_until, organise_state, in_inbox FROM thread').get(),
      ).toEqual({ snoozed_until: null, organise_state: '{}', in_inbox: 1 })
      expect(
        db.prepare('SELECT status, next_attempt, state_patch FROM mutation ORDER BY seq').all(),
      ).toEqual([
        { status: 'failed', next_attempt: 0, state_patch: '{}' },
        { status: 'pending', next_attempt: 0, state_patch: '{}' },
      ])
      expect(db.prepare("SELECT entity_id FROM change_log WHERE entity = 'thread'").all()).toEqual([
        { entity_id: 'a:t' },
      ])
    } finally {
      db.close()
    }
  })

  it('publishes canonical Gmail user Label memberships when upgrading from v18', () => {
    const db = openDatabase(':memory:')
    try {
      migrate(db, { migrations: MIGRATIONS.filter(({ version }) => version <= 18) })
      db.exec(`
        INSERT INTO account (id, kind, address, credentials, created_at)
        VALUES ('a', 'gmail', 'fixture@example.com', x'00', 0);
        INSERT INTO label (id, account_id, provider_id, name, kind)
        VALUES ('a:Label_existing', 'a', 'Label_existing', 'AMC/Snoozed', 'user');
        INSERT INTO thread (id, account_id, provider_thread_id, label_ids)
        VALUES ('a:t', 'a', 't', '["a:AMC/Snoozed","a:INBOX","a:Label_existing"]');
        INSERT INTO message (id, account_id, thread_id, provider_id, sent_at, label_ids, provider_label_ids)
        VALUES ('a:m1', 'a', 'a:t', 'm1', 1, '["a:AMC/Snoozed","a:INBOX"]', '["a:AMC/Snoozed","a:INBOX"]'),
               ('a:m2', 'a', 'a:t', 'm2', 2, '[]', NULL);
      `)
      expect(migrate(db)).toBe(latest)
      expect(
        db.prepare('SELECT label_ids, provider_label_ids, modseq FROM message ORDER BY id').all(),
      ).toEqual([
        {
          label_ids: '["a:Label_existing","a:INBOX"]',
          provider_label_ids: '["a:Label_existing","a:INBOX"]',
          modseq: 1,
        },
        { label_ids: '[]', provider_label_ids: null, modseq: 0 },
      ])
      expect(db.prepare('SELECT label_ids, modseq FROM thread').get()).toEqual({
        label_ids: '["a:Label_existing","a:INBOX"]',
        modseq: 2,
      })
      expect(
        db.prepare('SELECT entity, entity_id, op FROM change_log ORDER BY modseq').all(),
      ).toEqual([
        { entity: 'message', entity_id: 'a:m1', op: 'upsert' },
        { entity: 'thread', entity_id: 'a:t', op: 'upsert' },
      ])
    } finally {
      db.close()
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
