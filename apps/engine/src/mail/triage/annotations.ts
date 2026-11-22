import { createHash } from 'node:crypto'
import type { FilterCorrectionPage, FilterCounts, TriageBucketResult } from '@amc/protocol'
import type { Db } from '../../db/database.ts'
import { normalizeSender } from '../senders/index.ts'

function messageFeatures(db: Db, accountId: string, mid?: string, sender?: string) {
  const row = mid
    ? db
        .prepare(`
    SELECT m.imap_fingerprint, m.list_id, m.list_unsubscribe, m.from_json,
      (SELECT value FROM json_each(m.provider_label_ids)
        WHERE value IN (m.account_id || ':CATEGORY_PERSONAL', m.account_id || ':CATEGORY_SOCIAL',
          m.account_id || ':CATEGORY_PROMOTIONS', m.account_id || ':CATEGORY_UPDATES',
          m.account_id || ':CATEGORY_FORUMS') ORDER BY value LIMIT 1) AS category
    FROM message m WHERE m.id = ? AND m.account_id = ?
  `)
        .get(mid, accountId)
    : undefined
  const address = normalizeSender(sender ?? JSON.parse(String(row?.from_json ?? 'null'))?.address)
  const listIdHeader = typeof row?.list_id === 'string' ? row.list_id : ''
  const listId = /<([^<>\s]+)>/.exec(listIdHeader)?.[1] ?? listIdHeader.trim()
  return {
    messageKey: row?.imap_fingerprint ? `imap:${row.imap_fingerprint}` : (mid ?? null),
    senderHash: address
      ? createHash('sha256').update(accountId).update('\0').update(address).digest('hex')
      : null,
    domain: address?.split('@')[1] ?? null,
    listId: /^[a-z0-9._-]{1,255}$/i.test(listId) ? listId.toLowerCase() : null,
    hasListUnsubscribe: Number(!!row?.list_unsubscribe),
    category: typeof row?.category === 'string' ? row.category.slice(accountId.length + 1) : null,
  }
}

export function recordPrediction(
  db: Db,
  accountId: string,
  threadId: string,
  mid: string,
  label: string,
  metadata: TriageBucketResult,
  automaticActionId?: string,
) {
  const { messageKey } = messageFeatures(db, accountId, mid)
  db.prepare(`
    INSERT INTO triage_prediction (account_id, thread_id, message_key, input_revision, label,
      confidence, version, automatic_action_id, created_at)
    VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?)
  `).run(
    accountId,
    threadId,
    messageKey,
    metadata.inputRevision,
    label,
    metadata.confidence ?? null,
    metadata.version ?? 'legacy',
    automaticActionId ?? null,
    Date.now(),
  )
}

interface Annotation {
  actionId: string
  accountId: string
  threadId?: string
  mid?: string
  sender?: string
  label: string
  source: 'triage-key' | 'thread-action' | 'restore-from-filtered' | 'undo'
  error?: 'false-negative'
  restore?: boolean
  reason?: string
}

export function annotate(db: Db, input: Annotation) {
  const { actionId, accountId, threadId, mid, label, source } = input
  if (input.reason) setOwnerReason(db, actionId, input.reason)
  const id = source === 'undo' ? `undo:${actionId}` : actionId
  const meta = messageFeatures(db, accountId, mid, input.sender)
  const automatic =
    input.restore &&
    db
      .prepare(`
    SELECT p.id FROM triage_prediction p
    JOIN screening_work w ON w.action_id = p.automatic_action_id
    JOIN mutation m ON m.id = w.mutation_id
    WHERE p.account_id = ? AND p.message_key = ? AND p.invalidated_at IS NULL
          AND w.status IN ('applied', 'partial')
      AND EXISTS (SELECT 1 FROM json_each(m.write_journal) j WHERE json_array_length(j.value, '$.applied') > 0)
    ORDER BY p.id DESC LIMIT 1
  `)
      .get(accountId, meta.messageKey)
  const predicted =
    automatic ||
    db
      .prepare(`
    SELECT id FROM triage_prediction WHERE account_id = ? AND message_key = ? AND invalidated_at IS NULL
        ORDER BY id DESC LIMIT 1
  `)
      .get(accountId, meta.messageKey)
  db.prepare(`
    INSERT INTO triage_annotation (id, action_id, account_id, thread_id, message_id, message_key,
      label, source, prediction_id, error_type, sender_hash, sender_domain, list_id,
      has_list_unsubscribe, provider_category, created_at)
    VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?) ON CONFLICT (id) DO NOTHING
  `).run(
    id,
    actionId,
    accountId,
    threadId ?? null,
    mid ?? null,
    meta.messageKey,
    label,
    source,
    predicted?.id ?? null,
    automatic ? 'false-positive' : (input.error ?? null),
    meta.senderHash,
    meta.domain,
    meta.listId,
    meta.hasListUnsubscribe,
    meta.category,
    Date.now(),
  )
}

export function annotateUndo(db: Db, actionId: string) {
  const id = `undo:${actionId}`
  db.prepare(`
    INSERT INTO triage_annotation (id, action_id, account_id, thread_id, message_id, message_key,
      label, source, prediction_id, sender_hash, sender_domain, list_id,
      has_list_unsubscribe, provider_category, created_at)
    SELECT ?, action_id, account_id, thread_id, message_id, message_key, label, 'undo',
      prediction_id, sender_hash, sender_domain, list_id, has_list_unsubscribe, provider_category, ?
    FROM triage_annotation WHERE id = ? ON CONFLICT (id) DO NOTHING
  `).run(id, Date.now(), actionId)
  db.prepare(`
    UPDATE triage_annotation SET superseded_by = ?
    WHERE id = ? AND superseded_by IS NULL AND EXISTS (SELECT 1 FROM triage_annotation WHERE id = ?)
  `).run(id, actionId, id)
}

export function filterCounts(db: Db, accountId?: string): FilterCounts {
  const row = db
    .prepare(`
    SELECT count(*) FILTER (WHERE a.kind = 'filter:automatic') AS autoFiltered,
      count(*) FILTER (WHERE a.kind = 'filter:review') AS restored
    FROM owner_action a WHERE (?1 IS NULL OR a.account_id = ?1)
      AND (a.kind = 'filter:automatic' OR (a.kind = 'filter:review' AND a.request ->> 'decision' = 'not filtered'))
      AND EXISTS (SELECT 1 FROM screening_work w JOIN mutation m ON m.id = w.mutation_id
        WHERE w.action_id = a.id AND EXISTS (SELECT 1 FROM json_each(m.write_journal) j
          WHERE json_array_length(j.value, '$.applied') > 0))
  `)
    .get(accountId ?? null)
  return { autoFiltered: Number(row?.autoFiltered), restored: Number(row?.restored) }
}

export function filterCorrections(
  db: Db,
  accountId: string | undefined,
  cursor: string | undefined,
  limit: number,
): FilterCorrectionPage {
  const rows = db
    .prepare(`
    SELECT n.id, n.action_id AS actionId, n.account_id AS accountId, n.label AS decision,
      a.reason, n.source, n.created_at AS createdAt, n.superseded_by IS NOT NULL AS superseded
    FROM triage_annotation n JOIN owner_action a ON a.id = n.action_id
    WHERE (?1 IS NULL OR n.account_id = ?1) AND n.id > ?2 AND a.kind = 'filter:review'
    ORDER BY n.id LIMIT ?3
  `)
    .all(accountId ?? null, cursor ?? '', limit + 1) as (Omit<
    FilterCorrectionPage['corrections'][number],
    'superseded'
  > & { id: string; superseded: number })[]
  return {
    corrections: rows
      .slice(0, limit)
      .map(({ id: _, superseded, ...row }) => ({ ...row, superseded: !!superseded })),
    cursor: rows.length > limit ? (rows[limit - 1]?.id ?? null) : null,
  }
}

const verifiedMove = (action: 'n' | 'newer') => `EXISTS (
  SELECT 1 FROM screening_work w JOIN mutation m ON m.id = w.mutation_id
  WHERE w.action_id = ${action}.action_id AND w.status = 'applied'
    AND EXISTS (SELECT 1 FROM json_each(m.write_journal) j WHERE json_array_length(j.value, '$.applied') > 0)
)`
const currentFilterExample = `n.label IN ('filtered', 'not filtered')
  AND n.source != 'undo' AND n.superseded_by IS NULL AND ${verifiedMove('n')}
  AND NOT EXISTS (
    SELECT 1 FROM triage_annotation newer
    WHERE newer.account_id = n.account_id AND newer.message_key = n.message_key
      AND newer.label IN ('filtered', 'not filtered') AND newer.source != 'undo'
      AND newer.superseded_by IS NULL
      AND (newer.created_at, newer.rowid) > (n.created_at, n.rowid)
      AND ${verifiedMove('newer')}
  )`

export function hasPositiveFilterExample(db: Db, accountId: string) {
  return !!db
    .prepare(`
    SELECT 1 FROM triage_annotation n
    WHERE n.account_id = ? AND n.label = 'filtered' AND ${currentFilterExample}
    LIMIT 1
  `)
    .get(accountId)
}

export function readOwnerReason(db: Db, id?: string | null) {
  if (!id) return null
  const row = db.prepare('SELECT reason FROM owner_action WHERE id = ?').get(id)
  return typeof row?.reason === 'string' ? row.reason : null
}

export function setOwnerReason(db: Db, id: string, reason: string | null) {
  db.prepare('UPDATE owner_action SET reason = ? WHERE id = ?').run(reason || null, id)
}

export function editOwnerReason(db: Db, id: string, reason: string) {
  return (
    db
      .prepare(`
    UPDATE owner_action SET reason = ? WHERE id = ? AND (
      (kind = 'sender:decision' AND request ->> 'decision' = 'block') OR kind = 'filter:review'
    )
  `)
      .run(reason || null, id).changes > 0
  )
}

export function annotateFilterUndo(db: Db, id: string) {
  const auto = db
    .prepare(`
    SELECT a.account_id, a.request ->> 'threadId' AS thread_id, w.message_id
    FROM owner_action a JOIN screening_work w ON w.action_id = a.id
    WHERE a.id = ? AND a.kind = 'filter:automatic'
  `)
    .get(id)
  if (!auto) return annotateUndo(db, id)
  annotate(db, {
    actionId: id,
    accountId: String(auto.account_id),
    threadId: String(auto.thread_id),
    mid: String(auto.message_id),
    label: 'filtered',
    source: 'undo',
  })
}

export function invalidateAnnotations(db: Db, accountId: string) {
  db.prepare(
    "UPDATE triage_correction SET undo_status = 'superseded' WHERE account_id = ? AND undo_status IS NULL",
  ).run(accountId)
  db.prepare(
    "UPDATE triage_annotation SET superseded_by = 'imap-endpoint-changed' WHERE account_id = ? AND superseded_by IS NULL",
  ).run(accountId)
  db.prepare(
    'UPDATE triage_prediction SET invalidated_at = ? WHERE account_id = ? AND invalidated_at IS NULL',
  ).run(Date.now(), accountId)
}

export function correctionExamples(db: Db, accountId: string, inputs: string[] = []) {
  const features = inputs.map((mid) => messageFeatures(db, accountId, mid))
  const rows = db
    .prepare(`
    WITH candidates AS MATERIALIZED (
      SELECT value ->> 'senderHash' AS hash, value ->> 'domain' AS domain, value ->> 'listId' AS list_id
      FROM json_each(?2)
    ), examples AS (
      SELECT c.action_id, c.previous -> 'assignment' ->> 'bucket' AS previous, c.chosen,
        c.summary, o.reason AS ownerReason, n.sender_hash, n.sender_domain, n.list_id,
        c.message_id, c.created_at, 'bucket' AS kind
      FROM triage_correction c JOIN owner_action o ON o.id = c.action_id
      LEFT JOIN triage_annotation n ON n.id = c.action_id
      WHERE c.account_id = ?1 AND c.undo_status IS NULL
      UNION ALL
      SELECT n.action_id, NULL, n.label, '{}', o.reason, n.sender_hash, n.sender_domain, n.list_id,
        n.message_id, n.created_at, 'filter'
      FROM triage_annotation n JOIN owner_action o ON o.id = n.action_id
      WHERE n.account_id = ?1 AND ${currentFilterExample}
      UNION ALL
      SELECT n.action_id, NULL, n.label, '{}', o.reason, n.sender_hash, n.sender_domain, n.list_id,
        n.message_id, n.created_at, 'sender'
      FROM triage_annotation n JOIN owner_action o ON o.id = n.action_id
      JOIN sender_rule r ON r.action_id = o.id AND r.decision = 'block'
      WHERE n.account_id = ?1 AND n.source != 'undo' AND n.superseded_by IS NULL AND o.reason IS NOT NULL
    ), ranked AS (
      SELECT e.*, row_number() OVER (PARTITION BY kind ORDER BY
        coalesce((SELECT max(4 * (hash IS e.sender_hash AND hash IS NOT NULL)
          + 2 * (list_id IS e.list_id AND list_id IS NOT NULL)
          + (domain IS e.sender_domain AND domain IS NOT NULL)) FROM candidates), 0) DESC,
        e.created_at DESC, e.action_id DESC
      ) AS rank
      FROM examples e
    )
    SELECT e.previous, e.chosen, e.ownerReason, e.summary,
      substr(m.subject, 1, 240) AS subject, substr(m.snippet, 1, 480) AS snippet
    FROM ranked e LEFT JOIN message m ON m.id = e.message_id
    WHERE e.rank <= CASE WHEN e.kind = 'sender' THEN 6 ELSE 12 END
    ORDER BY e.rank, e.kind
  `)
    .all(accountId, JSON.stringify(features))
  return rows.map(({ previous, chosen, summary, subject, snippet, ownerReason }) => {
    const fallback = JSON.parse(String(summary)) as Partial<{ subject: string; snippet: string }>
    return {
      previous,
      chosen,
      ...(ownerReason ? { ownerReason } : {}),
      context: {
        subject: subject ?? fallback.subject ?? '',
        snippet: snippet ?? fallback.snippet ?? '',
      },
    }
  })
}
