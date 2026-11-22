import { createHmac, randomUUID } from 'node:crypto'
import { decisionLabels, type OwnerActionReasonInput, TAXONOMY_VERSION } from '@amc/protocol'
import { type Db, transaction } from '../../db/database.ts'
import { SenderError } from '../senders/actions.ts'
import { normalizeSender } from '../senders/index.ts'
import { canonicalListId } from '../store.ts'

type Axis = keyof typeof decisionLabels

export function generation(db: Db, accountId: string) {
  return Number(
    db.prepare('SELECT mailbox_generation FROM account WHERE id = ?').get(accountId)
      ?.mailbox_generation,
  )
}

export function privateDigest(db: Db, purpose: string, value: unknown) {
  const { secret } = db.prepare('SELECT secret FROM triage_key WHERE version = 1').get() as {
    secret: Uint8Array
  }
  return createHmac('sha256', secret)
    .update(JSON.stringify([purpose, value]))
    .digest('hex')
}

// A verified IMAP location carries its identity through verified moves and renames.
export function arrivalKey(db: Db, mid: string) {
  const row = db
    .prepare(`
    SELECT a.kind FROM message m JOIN account a ON a.id = m.account_id WHERE m.id = ?
  `)
    .get(mid)
  if (row?.kind === 'gmail') return mid
  if (row?.kind !== 'imap') return null
  const matches = db
    .prepare('SELECT arrival_key FROM imap_location WHERE message_id = ? LIMIT 2')
    .all(mid)
  const key = matches.length === 1 && matches[0]?.arrival_key
  return typeof key === 'string' ? `imap:${key}` : null
}

export function messageFeatures(
  db: Db,
  accountId: string,
  accountGeneration: number,
  mid?: string,
  sender?: string,
) {
  const row = mid
    ? db
        .prepare(`
    SELECT m.list_id, m.list_unsubscribe, m.from_json, a.kind,
      (SELECT value FROM json_each(m.provider_label_ids)
        WHERE value IN (m.account_id || ':CATEGORY_PERSONAL', m.account_id || ':CATEGORY_SOCIAL',
          m.account_id || ':CATEGORY_PROMOTIONS', m.account_id || ':CATEGORY_UPDATES',
          m.account_id || ':CATEGORY_FORUMS') ORDER BY value LIMIT 1) AS category
    FROM message m JOIN account a ON a.id = m.account_id WHERE m.id = ? AND m.account_id = ?
  `)
        .get(mid, accountId)
    : undefined
  const address = normalizeSender(sender ?? JSON.parse(String(row?.from_json ?? 'null'))?.address)
  const header = typeof row?.list_id === 'string' ? row.list_id : ''
  return {
    version: 1,
    senderHash: address
      ? privateDigest(db, 'sender', [accountId, accountGeneration, address])
      : null,
    senderKeyVersion: address ? 1 : null,
    domain: address?.split('@')[1] ?? null,
    listId: canonicalListId(header),
    hasListUnsubscribe: row ? !!row.list_unsubscribe : null,
    category:
      row?.kind === 'gmail' && typeof row.category === 'string'
        ? row.category.slice(accountId.length + 1)
        : null,
  }
}

interface Subject {
  accountId: string
  accountGeneration: number
  axis: Axis
  subjectKey: string
  threadId: string | null
  messageId: string | null
  arrival: string | null
  revision: number | null
  features: ReturnType<typeof messageFeatures>
}

export function subject(
  db: Db,
  input: {
    accountId: string
    axis: Axis
    threadId?: string
    mid?: string
    sender?: string
    revision?: number
  },
): Subject {
  const { accountId, axis, threadId, mid, sender, revision } = input
  const accountGeneration = generation(db, accountId)
  const features = messageFeatures(db, accountId, accountGeneration, mid, sender)
  const arrival = mid ? arrivalKey(db, mid) : null
  return {
    accountId,
    accountGeneration,
    axis,
    subjectKey: JSON.stringify(
      axis === 'sender' ? features.senderHash : axis === 'filter' ? arrival : [threadId, arrival],
    ),
    threadId: threadId ?? null,
    messageId: mid ?? null,
    arrival,
    revision: revision ?? null,
    features,
  }
}

interface Event {
  kind: 'decision' | 'prediction' | 'undo' | 'reason_revised'
  source: string
  dedupe: string
  label?: string | null
  actionId?: string
  targetId?: string
  predictionId?: string
  runId?: string
  confidence?: string | null
  producer?: {
    harnessId: string
    modelId: string | null
    adapterVersion: string
    promptVersion: string
  }
  detail?: Record<string, unknown>
}

export function appendEvent(db: Db, item: Subject, event: Event) {
  if (event.label && !decisionLabels[item.axis].safeParse(event.label).success)
    throw new Error('Invalid decision label for the axis')
  const id = randomUUID()
  db.prepare(`
    INSERT INTO triage_event (id, account_id, account_generation, axis, subject_key, thread_id,
      message_id, arrival_key, input_revision, kind, source, taxonomy_version, label_id, created_at,
      action_id, run_id, target_event_id, prediction_id, confidence, harness_id, model_id,
      adapter_version, prompt_version, features_json, detail_json, dedupe_key)
    VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)
  `).run(
    id,
    item.accountId,
    item.accountGeneration,
    item.axis,
    item.subjectKey,
    item.threadId,
    item.messageId,
    item.arrival,
    item.revision,
    event.kind,
    event.source,
    TAXONOMY_VERSION,
    event.label ?? null,
    Date.now(),
    event.actionId ?? null,
    event.runId ?? null,
    event.targetId ?? null,
    event.predictionId ?? null,
    event.confidence ?? null,
    event.producer?.harnessId ?? null,
    event.producer?.modelId ?? null,
    event.producer?.adapterVersion ?? null,
    event.producer?.promptVersion ?? null,
    JSON.stringify(item.features),
    JSON.stringify({ version: 1, ...event.detail }),
    event.dedupe,
  )
  return id
}

export function privateReasonsEnabled() {
  return process.env.AMC_PRIVATE_TRIAGE_REASONS !== '0'
}

export function checkOwnerReason(reason?: string | null) {
  if (reason && !privateReasonsEnabled())
    throw new SenderError('Private triage reasons are disabled', 400)
}

export function ownerReasonRetry(db: Db, id: string, reason?: string | null, retry = false) {
  if (!retry) checkOwnerReason(reason)
  const digest = privateDigest(db, 'owner reason', [id, reason || null])
  if (!retry) {
    db.prepare('INSERT INTO triage_request_fingerprint VALUES (?, ?)').run(id, digest)
    return
  }
  const saved = db.prepare('SELECT digest FROM triage_request_fingerprint WHERE id = ?').get(id)
  if (saved ? saved.digest !== digest : !!reason)
    throw new SenderError('Owner action ID was already used')
}

function saveReason(db: Db, id: string, reason?: string | null) {
  if (reason) db.prepare('INSERT INTO triage_owner_reason VALUES (?, ?)').run(id, reason)
}

export function annotate(
  db: Db,
  input: Parameters<typeof subject>[1] & {
    actionId: string
    label: string
    source: string
    reason?: string
    primaryReasonId?: string
    predictionId?: string
    restore?: boolean
  },
) {
  checkOwnerReason(input.reason)
  const item = subject(db, input)
  const candidate = input.restore
    ? db
        .prepare(`
    SELECT p.id FROM screening_work w JOIN triage_event p ON p.id = w.prediction_id
    JOIN mutation m ON m.id = w.mutation_id
    WHERE p.account_id = ? AND p.account_generation = ? AND p.arrival_key = ?
      AND w.message_id = ? AND w.status IN ('applied', 'partial')
      AND EXISTS (SELECT 1 FROM json_each(m.write_journal) j WHERE json_array_length(j.value, '$.applied') > 0)
    ORDER BY p.seq DESC LIMIT 1
  `)
        .get(item.accountId, item.accountGeneration, item.arrival, item.messageId)?.id
    : input.predictionId
  const prediction = candidate
    ? db
        .prepare(`
    SELECT id FROM triage_event WHERE id = ? AND kind = 'prediction' AND account_id = ?
      AND account_generation = ? AND axis = ? AND subject_key = ?
  `)
        .get(candidate, item.accountId, item.accountGeneration, item.axis, item.subjectKey)
    : undefined
  const id = appendEvent(db, item, {
    kind: 'decision',
    source: input.source,
    label: input.label,
    actionId: input.actionId,
    predictionId: prediction?.id ? String(prediction.id) : undefined,
    detail: { primaryReasonId: input.primaryReasonId },
    dedupe: JSON.stringify(['decision', input.actionId, item.axis, item.subjectKey]),
  })
  saveReason(db, id, input.reason)
  return id
}

export function annotateUndo(db: Db, actionId: string) {
  db.prepare(`
    INSERT INTO triage_event (id, account_id, account_generation, axis, subject_key, thread_id,
      message_id, arrival_key, input_revision, kind, source, taxonomy_version, created_at,
      action_id, target_event_id, features_json, detail_json, dedupe_key)
    SELECT lower(hex(randomblob(16))), account_id, account_generation, axis, subject_key, thread_id,
      message_id, arrival_key, input_revision, 'undo', source, taxonomy_version, ?, action_id, id,
      features_json, '{"version":1,"operation":"undo"}', 'undo:' || id
    FROM triage_event WHERE action_id = ? AND kind = 'decision'
      AND (source = 'legacy' OR account_generation = (SELECT mailbox_generation FROM account WHERE id = account_id))
    ON CONFLICT(dedupe_key) DO NOTHING
  `).run(Date.now(), actionId)
}

function primaryDecision(db: Db, actionId: string) {
  return db
    .prepare(`
    SELECT id, account_id, account_generation FROM triage_event
    WHERE action_id = ? AND kind = 'decision' ORDER BY seq LIMIT 1
  `)
    .get(actionId)
}

function reasonHead(db: Db, decisionId: string) {
  return db
    .prepare(`
    SELECT e.id, r.reason FROM triage_event e LEFT JOIN triage_owner_reason r ON e.id = r.event_id
    WHERE e.id = ? OR (e.kind = 'reason_revised' AND e.target_event_id = ?)
    ORDER BY e.seq DESC LIMIT 1
  `)
    .get(decisionId, decisionId)
}

export function readOwnerReason(db: Db, actionId: string) {
  const decision = primaryDecision(db, actionId)
  const head = decision && reasonHead(db, String(decision.id))
  return {
    reason: typeof head?.reason === 'string' ? head.reason : null,
    reasonRevision: head && (head.id !== decision?.id || head.reason) ? String(head.id) : null,
  }
}

export function editOwnerReason(db: Db, actionId: string, input: OwnerActionReasonInput) {
  return transaction(db, () => {
    const target = primaryDecision(db, actionId)
    if (!target) throw new SenderError('Owner action unavailable', 404)
    const dedupe = `reason:${input.editId}`
    if (db.prepare('SELECT 1 FROM triage_forgotten WHERE id = ?').get(dedupe))
      throw new SenderError('Reason edit ID was already used')
    const fingerprint = [actionId, input.expectedReasonRevision, input.reason]
    const digest = privateDigest(db, 'reason edit', fingerprint)
    const existing = db.prepare('SELECT id FROM triage_event WHERE dedupe_key = ?').get(dedupe)
    if (existing) {
      if (
        db.prepare('SELECT digest FROM triage_request_fingerprint WHERE id = ?').get(dedupe)
          ?.digest !== digest
      )
        throw new SenderError('Reason edit ID was already used')
      return { reason: input.reason, reasonRevision: String(existing.id) }
    }
    checkOwnerReason(input.reason)
    if (
      target.account_generation !== generation(db, String(target.account_id)) ||
      readOwnerReason(db, actionId).reasonRevision !== input.expectedReasonRevision
    )
      throw new SenderError('The reason changed. Refresh and retry.')
    const id = randomUUID()
    db.prepare(`
      INSERT INTO triage_event (id, account_id, account_generation, axis, subject_key, thread_id,
        message_id, arrival_key, input_revision, kind, source, taxonomy_version, created_at,
        action_id, target_event_id, features_json, detail_json, dedupe_key)
      SELECT ?, account_id, account_generation, axis, subject_key, thread_id, message_id, arrival_key,
        input_revision, 'reason_revised', source, taxonomy_version, ?, action_id, id,
        features_json, '{"version":1}', ? FROM triage_event WHERE id = ?
    `).run(id, Date.now(), dedupe, target.id ?? null)
    db.prepare('INSERT INTO triage_request_fingerprint VALUES (?, ?)').run(dedupe, digest)
    saveReason(db, id, input.reason)
    return { reason: input.reason, reasonRevision: id }
  })
}

export function advanceMailboxGeneration(db: Db, accountId: string) {
  db.prepare('UPDATE account SET mailbox_generation = mailbox_generation + 1 WHERE id = ?').run(
    accountId,
  )
  db.prepare(
    "UPDATE triage_correction SET undo_status = 'superseded' WHERE account_id = ? AND undo_status IS NULL",
  ).run(accountId)
  db.prepare(
    'UPDATE thread SET filter_suggestion_message_id = NULL, filter_suggestion_event_id = NULL WHERE account_id = ?',
  ).run(accountId)
  db.prepare(`
    UPDATE screening_work SET status = CASE WHEN status = 'pending' THEN 'superseded' ELSE status END,
      undo_error = coalesce(undo_error, 'Undo unavailable: mailbox identity changed')
    WHERE action_id IN (SELECT id FROM owner_action WHERE account_id = ?)
      AND (undo_id IS NULL OR undo_id IN (SELECT id FROM mutation WHERE status = 'pending'))
  `).run(accountId)
}
