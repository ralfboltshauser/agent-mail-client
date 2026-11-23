import { createHash } from 'node:crypto'
import { Bucket, bucketLabels } from '@amc/protocol'
import { type Db, transaction } from '../../db/database.ts'
import { normalizeSender } from '../senders/index.ts'
import { privateDigest } from './annotations.ts'

interface LegacyAction {
  account_id: string
  id: string
  kind: string
  request: string
  created_at: number
  token_id: string
  undo_requested_at: number | null
}

interface Bridge {
  cursor_at: number | null
  cursor_id: string | null
  imported: number
  skipped: number
  complete: number
}

export function bridgeStatus(db: Db) {
  const { imported, skipped, complete } = progress(db)
  return { imported, skipped, complete: !!complete }
}

function progress(db: Db) {
  return db.prepare('SELECT * FROM triage_bridge WHERE slot = 1').get() as unknown as Bridge
}

export function legacyDecisionId(account: string, action: string) {
  return `legacy:${createHash('sha256')
    .update(JSON.stringify([account, action]))
    .digest('hex')}`
}

function requestRecord(input: string): Record<string, unknown> {
  try {
    const parsed = JSON.parse(input)
    return parsed && typeof parsed === 'object' && !Array.isArray(parsed) ? parsed : {}
  } catch {
    // Malformed legacy application data has no usable fields to bridge.
    return {}
  }
}

// The v21 restore writer allocated the next revision under the original Account and
// Undo token. Require agreement with the recorded inverse and exactly one candidate.
function restoreTarget(
  db: Db,
  row: LegacyAction,
  address: string,
  revision: unknown,
  choice: string,
) {
  if (typeof revision !== 'number' || !Number.isSafeInteger(revision)) return null
  const rows = db
    .prepare(`
    SELECT id FROM owner_action WHERE kind = 'sender:decision' AND undo_requested_at IS NOT NULL
      AND account_id = ? AND undo_token_id = ? AND undo_requested_at <= ?
      AND CASE WHEN json_valid(request) THEN
        request ->> 'address' = ? AND request ->> 'revision' = ?
        AND coalesce(request ->> '$.previous.decision', 'clear') = ?
      END LIMIT 2
  `)
    .all(row.account_id, row.token_id, row.created_at, address, revision - 1, choice)
  if (rows.length !== 1) return null
  const action = String(rows[0]?.id)
  return String(
    db.prepare("SELECT id FROM triage_event WHERE action_id = ? AND kind = 'decision'").get(action)
      ?.id ?? legacyDecisionId(row.account_id, action),
  )
}

function decisionFacts(db: Db, row: LegacyAction) {
  const input = requestRecord(row.request)
  if (row.kind.startsWith('sender:')) {
    const address = typeof input.address === 'string' ? normalizeSender(input.address) : null
    const rule = db
      .prepare(`
      SELECT address, decision, revision FROM sender_rule WHERE account_id = ? AND action_id = ?
    `)
      .get(row.account_id, row.id)
    const sender =
      address ?? (typeof rule?.address === 'string' ? normalizeSender(rule.address) : null)
    const choice = input.decision ?? (rule && (rule.decision ?? 'clear'))
    if (
      !sender ||
      (rule && (rule.address !== sender || (rule.decision ?? 'clear') !== choice)) ||
      (choice !== 'accept' && choice !== 'block' && choice !== 'clear')
    )
      return null
    const revision = Number.isSafeInteger(input.revision) ? input.revision : rule?.revision
    return {
      axis: 'sender',
      label: `sender.${choice}`,
      subject: privateDigest(db, 'sender', [row.account_id, 0, sender]),
      detail: { revision },
      target:
        row.kind === 'sender:restore' ? restoreTarget(db, row, sender, revision, choice) : null,
      undoAt: row.kind === 'sender:decision' ? row.undo_requested_at : null,
    }
  }
  const correction = db
    .prepare(`
    SELECT thread_id, message_id, input_revision, chosen, undo_status FROM triage_correction
    WHERE action_id = ? AND account_id = ?
  `)
    .get(row.id, row.account_id)
  if (row.kind === 'bucket:review' && !correction) return null
  const thread = correction?.thread_id ?? input.threadId
  const chosen = correction ? correction.chosen : input.bucket
  const parsed = Bucket.safeParse(chosen)
  if (typeof thread !== 'string' || !thread || (chosen !== null && !parsed.success)) return null
  return {
    axis: 'bucket',
    label: parsed.success ? bucketLabels[parsed.data] : 'bucket.clear',
    subject: JSON.stringify([thread, null]),
    thread,
    message: typeof correction?.message_id === 'string' ? correction.message_id : null,
    revision: typeof correction?.input_revision === 'number' ? correction.input_revision : null,
    undoAt: correction?.undo_status === 'applied' ? row.undo_requested_at : null,
  }
}

function importAction(db: Db, row: LegacyAction) {
  const id = legacyDecisionId(row.account_id, row.id)
  if (
    db.prepare('SELECT 1 FROM triage_forgotten WHERE id = ?').get(id) ||
    db.prepare('SELECT 1 FROM triage_event WHERE action_id = ?').get(row.id) ||
    db.prepare('SELECT 1 FROM triage_request_fingerprint WHERE id = ?').get(row.id)
  )
    return 'ignored'
  const facts = decisionFacts(db, row)
  if (!facts || !db.prepare('SELECT 1 FROM account WHERE id = ?').get(row.account_id))
    return 'skipped'
  db.prepare(`
    INSERT INTO triage_event (id, account_id, account_generation, axis, subject_key,
      thread_id, message_id, input_revision, kind, source, taxonomy_version, label_id,
      created_at, action_id, target_event_id, features_json, detail_json, dedupe_key)
    VALUES (?, ?, 0, ?, ?, ?, ?, ?, 'decision', 'legacy', 1, ?, ?, ?, ?, '{"version":1}', ?, ?)
  `).run(
    id,
    row.account_id,
    facts.axis,
    facts.subject,
    facts.thread ?? null,
    facts.message ?? null,
    facts.revision ?? null,
    facts.label,
    row.created_at,
    row.id,
    facts.target ?? null,
    JSON.stringify({
      version: 1,
      generation: 'unknown',
      ...(row.kind === 'sender:restore' ? { transition: 'restore' } : {}),
      ...facts.detail,
    }),
    id,
  )
  if (facts.undoAt !== null)
    db.prepare(`
    INSERT INTO triage_event (id, account_id, account_generation, axis, subject_key, thread_id,
      message_id, input_revision, kind, source, taxonomy_version, created_at, action_id,
      target_event_id, features_json, detail_json, dedupe_key)
    SELECT 'undo:' || id, account_id, account_generation, axis, subject_key, thread_id,
      message_id, input_revision, 'undo', source, taxonomy_version, ?, action_id, id,
      features_json, '{"version":1,"operation":"undo"}', 'undo:' || id
    FROM triage_event WHERE id = ?
  `).run(facts.undoAt, id)
  return 'imported'
}

export function backfillLegacyBatch(db: Db, limit = 100) {
  return transaction(db, () => {
    const state = progress(db)
    if (state.complete) return false
    const boundary = state.cursor_at === null ? [] : [state.cursor_at, state.cursor_id]
    const rows = db
      .prepare(`
      SELECT a.* FROM owner_action a
      WHERE a.legacy_candidate = 1 ${boundary.length ? 'AND (a.created_at, a.id) > (?, ?)' : ''}
        AND a.kind IN ('sender:decision', 'sender:restore', 'bucket:review', 'bucket:manual')
      ORDER BY a.created_at, a.id LIMIT ?
    `)
      .all(...boundary, limit) as unknown as LegacyAction[]
    let imported = 0
    let skipped = 0
    for (const row of rows) {
      const result = importAction(db, row)
      if (result === 'imported') imported++
      if (result === 'skipped') skipped++
    }
    const last = rows.at(-1)
    const more = rows.length === limit
    db.prepare(`
      UPDATE triage_bridge SET cursor_at = ?, cursor_id = ?, imported = imported + ?,
        skipped = skipped + ?, complete = ? WHERE slot = 1
    `).run(
      last?.created_at ?? state.cursor_at,
      last?.id ?? state.cursor_id,
      imported,
      skipped,
      Number(!more),
    )
    return more
  })
}
