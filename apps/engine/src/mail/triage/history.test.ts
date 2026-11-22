import { randomUUID } from 'node:crypto'
import { mkdirSync, readFileSync, renameSync } from 'node:fs'
import { join } from 'node:path'
import { DatabaseSync } from 'node:sqlite'
import { Writable } from 'node:stream'
import { TriageHistoryQuery } from '@amc/protocol'
import pino from 'pino'
import { expect, it } from 'vitest'
import { issueToken } from '../../auth/tokens.ts'
import { restoreDatabase } from '../../db/backups.ts'
import { backupTo, migrate, openDatabase, transaction } from '../../db/database.ts'
import { MIGRATIONS } from '../../db/migrations.ts'
import { createApp } from '../../http/app.ts'
import { testConfig, testDb } from '../../test-support.ts'
import { advanceMailboxGeneration, annotate, editOwnerReason } from './annotations.ts'
import { ERASURE_LEDGER_FILE, forgetDecision, openErasureLedger } from './erasure.ts'
import { exportHistory, readHistory } from './history.ts'
import { backfillLegacyBatch, bridgeStatus } from './legacy.ts'

const CANARY = 'synthetic-private-history-00f35ca5'
const LEGACY_CANARY = 'synthetic-copied-mail-124f3be0'
const account =
  "INSERT INTO account (id, kind, address, credentials, created_at) VALUES ('fixture-account', 'gmail', 'owner@example.test', X'00', 0)"
const base = {
  accountId: 'fixture-account',
  axis: 'filter',
  source: 'triage_key',
  label: 'filter.filtered',
} as const

it('reconciles v21 and v22 records across a durable cutoff, crash and rerun without changing projections', () => {
  const config = testConfig()
  const path = join(config.dataDir, 'bridge.db')
  const backup = join(config.dataDir, 'v23.db')
  const ledger = join(config.dataDir, ERASURE_LEDGER_FILE)
  let db = openDatabase(path)
  migrate(db, { migrations: MIGRATIONS.filter(({ version }) => version <= 21) })
  db.exec(account)
  db.exec(`
    INSERT INTO owner_action VALUES
      ('sender-a', 'fixture-account', 'owner', 'sender:decision',
        '{"address":"feed@example.test","decision":"accept","revision":1}', 4, 5, 'owner'),
      ('sender-restored', 'fixture-account', 'owner', 'sender:restore',
        '{"address":"feed@example.test","decision":"clear","revision":2}', 6, NULL, NULL),
      ('manual-clear', 'fixture-account', 'owner', 'bucket:manual',
        '{"threadId":"fixture-thread","bucket":null}', 7, NULL, NULL),
      ('bad-json', 'fixture-account', 'owner', 'bucket:manual', '{', 8, NULL, NULL);
    INSERT INTO sender_rule VALUES ('fixture-account', 'feed@example.test', NULL, 2, 'sender-restored', 6);
  `)
  migrate(db, { migrations: MIGRATIONS.filter(({ version }) => version <= 23) })
  db.exec(`
    INSERT INTO thread (id, account_id, provider_thread_id, bucket)
      VALUES ('fixture-thread', 'fixture-account', 'fixture', 'Later');
    INSERT INTO owner_action VALUES
      ('review-a', 'fixture-account', 'owner', 'bucket:review', '{}', 9, 10, 'owner'),
      ('orphan', 'fixture-account', 'owner', 'bucket:review', '{}', 10, NULL, NULL);
    INSERT INTO triage_correction VALUES ('review-a', 'fixture-account', 'fixture-thread',
      'missing-message', 22, 'revision', '{"assignment":{"bucket":"Update"}}',
      'Later', '{"subject":"${LEGACY_CANARY}"}', 9, 'superseded');
  `)
  db.exec(`
    INSERT INTO owner_action VALUES ('fresh-v23', 'fixture-account', 'owner', 'bucket:manual',
      '{"threadId":"fixture-thread","bucket":"Later"}', 11, NULL, NULL);
  `)
  const live = annotate(db, {
    accountId: 'fixture-account',
    actionId: 'fresh-v23',
    axis: 'bucket',
    threadId: 'fixture-thread',
    source: 'thread_action',
    label: 'bucket.later',
  })
  const projections = () => [
    db.prepare('SELECT * FROM triage_correction').all(),
    db.prepare('SELECT * FROM sender_rule').all(),
    db.prepare('SELECT * FROM thread').all(),
  ]
  const before = projections()
  backupTo(db, backup)
  expect(migrate(db)).toBe(24)
  expect(migrate(db)).toBe(24)
  expect(backfillLegacyBatch(db, 1)).toBe(true)
  expect(() =>
    transaction(db, () => {
      backfillLegacyBatch(db, 2)
      throw new Error('simulated crash before commit')
    }),
  ).toThrow('simulated crash')
  expect(bridgeStatus(db)).toEqual({ imported: 1, skipped: 0, complete: false })
  db.close()
  db = openDatabase(path)
  while (backfillLegacyBatch(db, 1)) {}
  const events = db.prepare('SELECT * FROM triage_event ORDER BY seq').all()
  expect(events[0]?.id).toBe(live)
  expect(events.slice(1).map((event) => event.label_id)).toEqual([
    'sender.accept',
    null,
    'sender.clear',
    'bucket.clear',
    'bucket.later',
  ])
  expect(events[3]?.target_event_id).toBe(events[1]?.id)
  expect(events[5]).toMatchObject({
    account_generation: 0,
    arrival_key: null,
    message_id: 'missing-message',
  })
  expect(bridgeStatus(db)).toEqual({ imported: 4, skipped: 2, complete: true })
  expect(projections()).toEqual(before)
  // Rewind only the scanner, simulating duplicate source delivery across a restart.
  db.exec('UPDATE triage_bridge SET cursor_id = NULL, cursor_at = NULL, complete = 0')
  while (backfillLegacyBatch(db, 2)) {}
  expect(db.prepare('SELECT * FROM triage_event ORDER BY seq').all()).toEqual(events)
  expect(exportHistory(db, { includeReasons: true })).not.toContain(LEGACY_CANARY)
  advanceMailboxGeneration(db, 'fixture-account')
  expect(
    readHistory(db, TriageHistoryQuery.parse({}))
      .events.filter((event) => event.source === 'legacy')
      .every((event) => event.generation === null),
  ).toBe(true)
  const closeLedger = openErasureLedger(db, ledger)
  const erased = String(events[5]?.id)
  forgetDecision(db, erased)
  closeLedger()
  db.close()
  restoreDatabase(backup, path)
  db = openDatabase(path)
  while (backfillLegacyBatch(db)) {}
  expect(db.prepare('SELECT id FROM triage_event WHERE id = ?').get(erased)).toBeUndefined()
  expect(db.prepare('SELECT summary FROM triage_correction').get()?.summary).toBe('{}')
  expect(db.prepare('SELECT previous FROM triage_correction').get()?.previous).toBe(
    '{"assignment":{"bucket":"Update"}}',
  )
  db.close()
})

function sharedDecision(db: ReturnType<typeof testDb>) {
  db.exec(account)
  const actionId = randomUUID()
  const first = annotate(db, { ...base, actionId, threadId: 'fixture-thread', reason: CANARY })
  // Filter writes the primary link after storing the first per-message decision.
  const second = annotate(db, {
    ...base,
    axis: 'bucket',
    label: 'bucket.later',
    actionId,
    threadId: 'fixture-thread',
    primaryReasonId: first,
  })
  const edit = { editId: randomUUID(), expectedReasonRevision: first, reason: `${CANARY}-revision` }
  editOwnerReason(db, actionId, edit)
  return { first, second, actionId, edit }
}

it('gates history, JSONL and forget on owner admin; removes shared reasons from every read', async () => {
  const config = testConfig()
  const db = testDb()
  const closeLedger = openErasureLedger(db, join(config.dataDir, ERASURE_LEDGER_FILE))
  const { first, second, actionId, edit } = sharedDecision(db)
  const logs: string[] = []
  const log = pino(
    new Writable({
      write(chunk, _encoding, done) {
        logs.push(String(chunk))
        done()
      },
    }),
  )
  const app = createApp({ db, config, log })
  const owner = issueToken(db, { kind: 'cli', name: 'owner', scopes: ['admin'] }).secret
  const agent = issueToken(db, {
    kind: 'agent',
    name: 'agent',
    accountId: 'fixture-account',
    scopes: ['read', 'organize'],
    expiresAt: Date.now() + 60_000,
  }).secret
  const api = (path = '', method = 'GET', body?: unknown, token = owner) =>
    app.request(`/v1/triage/events${path}`, {
      method,
      headers: {
        Authorization: `Bearer ${token}`,
        'Content-Type': 'application/json',
      },
      body: body === undefined ? undefined : JSON.stringify(body),
    })
  expect((await api('', 'GET', undefined, agent)).status).toBe(403)
  expect((await api('/export', 'POST', { includeReasons: true }, agent)).status).toBe(403)
  expect((await api(`/${second}`, 'DELETE', undefined, agent)).status).toBe(403)
  const redacted = await api('?limit=1')
  expect(redacted.headers.get('Cache-Control')).toBe('no-store')
  const page = await redacted.json()
  expect(JSON.stringify(page)).not.toContain(CANARY)
  expect((await (await api(`?limit=1&before=${page.before}`)).json()).events[0].id).not.toBe(
    page.events[0].id,
  )
  expect(await (await api('?includeReasons=1')).text()).toContain(`${CANARY}-revision`)
  const response = await api('/export', 'POST', {})
  expect(response.headers.get('Content-Type')).toContain('application/x-ndjson')
  const output = await response.text()
  expect(output).not.toContain(CANARY)
  expect(output).not.toContain('fixture-account')
  expect(output).not.toContain('fixture-thread')
  const [manifest, ...events] = output
    .trim()
    .split('\n')
    .map((line) => JSON.parse(line))
  expect(manifest).toMatchObject({
    format: 'amc.owner-preferences',
    version: 1,
    reasons: 'redacted',
  })
  expect(events.map((event) => event.sequence)).toEqual([1, 2, 3])
  expect(await (await api('/export', 'POST', { includeReasons: true })).text()).toContain(CANARY)
  expect((await api('/export', 'POST', { includeReasons: CANARY })).status).toBe(400)
  expect((await api(`/${second}`, 'DELETE')).status).toBe(204)
  expect((await api(`/${second}`, 'DELETE')).status).toBe(204)
  expect(await (await api('?includeReasons=1')).text()).not.toContain(CANARY)
  const after = await (await api('/export', 'POST', { includeReasons: true })).text()
  expect(after).toContain(first)
  expect(after).not.toContain(second)
  expect(after).not.toContain(CANARY)
  expect(() => editOwnerReason(db, actionId, edit)).toThrow('already used')
  expect(logs.join('')).not.toContain(CANARY)
  closeLedger()
  db.close()
})

it('replays the durable erase ledger before publishing an older backup and purges SQLite bytes', () => {
  const { dataDir, backupDir } = testConfig()
  mkdirSync(backupDir)
  const path = join(dataDir, 'amc.db')
  const ledger = join(dataDir, ERASURE_LEDGER_FILE)
  const backup = join(backupDir, 'original.db')
  let db = openDatabase(path)
  migrate(db)
  let closeLedger = openErasureLedger(db, ledger)
  const { second } = sharedDecision(db)
  backupTo(db, backup)
  expect(readFileSync(backup).includes(CANARY)).toBe(true)
  forgetDecision(db, second)
  expect(readFileSync(path).includes(CANARY)).toBe(false)
  expect(readFileSync(`${path}-wal`).includes(CANARY)).toBe(false)
  closeLedger()
  db.close()
  renameSync(ledger, `${ledger}.saved`)
  expect(() => restoreDatabase(backup, path)).toThrow('ledger is missing')
  renameSync(`${ledger}.saved`, ledger)
  restoreDatabase(backup, path)
  expect(readFileSync(path).includes(CANARY)).toBe(false)
  db = openDatabase(path)
  closeLedger = openErasureLedger(db, ledger)
  expect(exportHistory(db, { includeReasons: true })).not.toContain(CANARY)
  expect(db.prepare('SELECT id FROM triage_event WHERE id = ?').get(second)).toBeUndefined()
  closeLedger()
  db.close()
  const original = new DatabaseSync(backup, { readOnly: true })
  expect(original.prepare('SELECT count(*) AS count FROM triage_owner_reason').get()?.count).toBe(2)
  original.close()
})
