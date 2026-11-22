import { randomUUID } from 'node:crypto'
import { closeSync, existsSync, lstatSync, openSync } from 'node:fs'
import { DatabaseSync } from 'node:sqlite'
import { type Db, transaction } from '../../db/database.ts'
import { SenderError } from '../senders/actions.ts'
import { legacyDecisionId } from './legacy.ts'

interface Erasure {
  id: string
  action_id: string
  legacy_id: string
  pending: number
}

export const ERASURE_LEDGER_FILE = 'owner-erasure.sqlite'
const ledgers = new WeakMap<Db, Db>()

export function erasureLedgerId(db: Db) {
  if (!db.prepare("SELECT 1 FROM sqlite_schema WHERE name = 'triage_privacy_store'").get())
    return null
  return db.prepare('SELECT ledger_id FROM triage_privacy_store WHERE slot = 1').get()?.ledger_id
}

export function openErasureLedger(db: Db, path: string, expectedId?: string) {
  const marker = erasureLedgerId(db)
  if (marker && expectedId && marker !== expectedId)
    throw new Error('The backup belongs to a different owner erasure ledger')
  const known = marker ?? expectedId
  if (!existsSync(path)) {
    if (known) throw new Error('The owner erasure ledger is missing')
    closeSync(openSync(path, 'wx', 0o600))
  }
  const entry = lstatSync(path)
  if (!entry.isFile() || (entry.mode & 0o077) !== 0)
    throw new Error('The owner erasure ledger must be a private regular file')
  const ledger = new DatabaseSync(path)
  try {
    ledger.exec(`
      PRAGMA synchronous = EXTRA;
      CREATE TABLE IF NOT EXISTS identity (slot INTEGER PRIMARY KEY CHECK(slot = 1), id TEXT NOT NULL);
      CREATE TABLE IF NOT EXISTS erasure (
        id TEXT PRIMARY KEY, action_id TEXT NOT NULL, legacy_id TEXT NOT NULL, pending INTEGER NOT NULL
      ) STRICT;
    `)
    if (!known) ledger.prepare('INSERT OR IGNORE INTO identity VALUES (1, ?)').run(randomUUID())
    const ledgerId = ledger.prepare('SELECT id FROM identity').get()?.id
    if (typeof ledgerId !== 'string' || (known && known !== ledgerId))
      throw new Error('The database and owner erasure ledger do not match')
    db.prepare('INSERT OR IGNORE INTO triage_privacy_store (slot, ledger_id) VALUES (1, ?)').run(
      ledgerId,
    )
    replayErasure(db, ledger)
    ledgers.set(db, ledger)
    return () => {
      ledgers.delete(db)
      ledger.close()
    }
  } catch (error) {
    ledger.close()
    throw error
  }
}

function applyErasure(db: Db, { id, action_id, legacy_id }: Erasure) {
  const addTombstone = db.prepare('INSERT OR IGNORE INTO triage_forgotten VALUES (?)')
  addTombstone.run(id)
  addTombstone.run(legacy_id)

  // Batch decisions store one reason on the first event. Revisions also belong to that
  // shared reason, including revisions written after the snapshot being restored.
  const reasons = db
    .prepare(`
    SELECT id, dedupe_key FROM triage_event WHERE kind = 'reason_revised' AND action_id = ?
  `)
    .all(action_id)
  const eraseReason = db.prepare('DELETE FROM triage_owner_reason WHERE event_id = ?')
  const eraseFingerprint = db.prepare('DELETE FROM triage_request_fingerprint WHERE id = ?')
  for (const revision of reasons) {
    const revisionId = String(revision.id)
    const editKey = String(revision.dedupe_key)
    eraseReason.run(revisionId)
    eraseFingerprint.run(editKey)
    addTombstone.run(editKey)
    addTombstone.run(revisionId)
  }
  db.prepare(`
    DELETE FROM triage_owner_reason WHERE event_id IN (
      SELECT id FROM triage_event WHERE action_id = ? AND kind = 'decision')
  `).run(action_id)
  eraseFingerprint.run(action_id)
  db.prepare(`
    DELETE FROM triage_event WHERE (kind = 'reason_revised' AND action_id = ?)
      OR (kind = 'undo' AND target_event_id IN (?, ?)) OR id IN (?, ?)
  `).run(action_id, id, legacy_id, id, legacy_id)
  db.prepare(
    "UPDATE triage_correction SET summary = '{}' WHERE action_id = ? AND summary != '{}'",
  ).run(action_id)
  // Phase 2 has no policy/evaluation caches. The single worker lease fences triage submissions.
  db.exec('DELETE FROM triage_lease')
}

function checkpoint(db: Db) {
  if (db.prepare('PRAGMA wal_checkpoint(TRUNCATE)').get()?.busy !== 0)
    throw new Error('SQLite could not purge the triage journal')
}

function replayErasure(db: Db, ledger: Db) {
  const entries = ledger
    .prepare('SELECT * FROM erasure ORDER BY rowid')
    .all() as unknown as Erasure[]
  const pending = entries.filter((entry) => entry.pending || !isForgotten(db, entry.id))
  const needsPurge = db
    .prepare('SELECT purge_pending FROM triage_privacy_store')
    .get()?.purge_pending
  if (!pending.length && !needsPurge) return
  db.exec('PRAGMA secure_delete = ON')
  transaction(db, () => {
    db.prepare('UPDATE triage_privacy_store SET purge_pending = 1, receipt_epoch = ?').run(
      randomUUID(),
    )
    for (const entry of pending) applyErasure(db, entry)
  })
  checkpoint(db)
  db.exec('VACUUM')
  checkpoint(db)
  db.exec('UPDATE triage_privacy_store SET purge_pending = 0')
  ledger.exec('UPDATE erasure SET pending = 0 WHERE pending = 1')
}

function isForgotten(db: Db, id: string) {
  return db.prepare('SELECT 1 FROM triage_forgotten WHERE id = ?').get(id)
}

export function forgetDecision(db: Db, id: string) {
  const ledger = ledgers.get(db)
  if (!ledger) throw new SenderError('Owner erasure storage unavailable', 503)
  const event = db
    .prepare(`
    SELECT account_id, action_id FROM triage_event WHERE id = ? AND kind = 'decision'
  `)
    .get(id)
  if (!event && !isForgotten(db, id)) throw new SenderError('Decision unavailable', 404)
  if (event) {
    const action = String(event.action_id)
    ledger
      .prepare('INSERT OR IGNORE INTO erasure VALUES (?, ?, ?, 1)')
      .run(id, action, legacyDecisionId(String(event.account_id), action))
  }
  replayErasure(db, ledger)
}
