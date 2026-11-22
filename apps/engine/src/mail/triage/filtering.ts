import { randomUUID } from 'node:crypto'
import {
  type FilteredPage,
  type FilterReviewInput,
  TRIAGE_RECENT_WINDOW_MS,
  type TriageBucketResult,
} from '@amc/protocol'
import type { Principal } from '../../auth/tokens.ts'
import { type Db, transaction } from '../../db/database.ts'
import type { OwnerActionHandler } from '../../http/senders.ts'
import { assertOwner, liveOwner, SenderError, workActionStatus } from '../senders/actions.ts'
import { isOwnerAddress } from '../senders/index.ts'
import { labelId, type MailStore } from '../store.ts'
import {
  annotate,
  annotateFilterUndo,
  hasPositiveFilterExample,
  recordPrediction,
} from './annotations.ts'
import { markHandled, threadInput } from './input.ts'

const OWNER = 'filter:review'
const AUTO = 'filter:automatic'
// IMAP membership belongs to verified locations. Gmail keeps an independent provider baseline.
const providerMembership = `CASE WHEN a.kind = 'imap' THEN (
  SELECT json_group_array(label_id) FROM imap_location WHERE message_id = m.id AND verified = 1
) ELSE coalesce(m.provider_label_ids, m.label_ids) END`
const eligibleMail = `
  NOT EXISTS (SELECT 1 FROM json_each(${providerMembership})
    WHERE value IN (m.account_id || ':SENT', m.account_id || ':DRAFT',
      m.account_id || ':SPAM', m.account_id || ':TRASH'))`

function matchingMessages(db: Db, threadId: string, source: string) {
  return db
    .prepare(`
    SELECT m.id FROM message m JOIN account a ON a.id = m.account_id
    WHERE m.thread_id = ? AND ${eligibleMail}
      AND ? IN (SELECT value FROM json_each(${providerMembership}))
    ORDER BY coalesce(m.delivered_at, m.sent_at) DESC, m.id DESC
  `)
    .all(threadId, source) as { id: string }[]
}

function filterAction(db: Db, id: string) {
  return db
    .prepare(`
    SELECT id, account_id, kind, request, token_id, undo_requested_at
    FROM owner_action WHERE id = ? AND kind IN ('filter:review', 'filter:automatic')
  `)
    .get(id) as
    | {
        id: string
        account_id: string
        kind: string
        request: string
        token_id: string
        undo_requested_at: number | null
      }
    | undefined
}

function sourceLabel(db: Db, accountId: string, restore: boolean) {
  if (!restore) return labelId(accountId, 'INBOX')
  const row = db
    .prepare(
      "SELECT provider_id FROM filtered_destination WHERE account_id = ? AND state = 'ready'",
    )
    .get(accountId)
  return row?.provider_id ? labelId(accountId, String(row.provider_id)) : null
}

function enqueue(
  db: Db,
  id: string,
  accountId: string,
  tokenId: string,
  kind: string,
  request: object,
  ids: string[],
) {
  db.prepare(`
    INSERT INTO owner_action (id, account_id, token_id, kind, request, created_at)
    VALUES (?, ?, ?, ?, ?, ?)
  `).run(id, accountId, tokenId, kind, JSON.stringify(request), Date.now())
  const insert = db.prepare(
    'INSERT INTO screening_work (action_id, identity, message_id) VALUES (?, ?, ?)',
  )
  for (const mid of ids) insert.run(id, mid, mid)
}

export function reviewFilter(store: MailStore, principal: Principal, input: FilterReviewInput) {
  const { db } = store
  return transaction(db, () => {
    assertOwner(db, principal)
    const id = input.clientActionId
    const { reason, ...request } = input
    if (db.prepare('SELECT 1 FROM owner_action WHERE id = ?').get(id)) {
      const existing = filterAction(db, id)
      if (
        existing?.kind !== OWNER ||
        existing.token_id !== principal.tokenId ||
        existing.request !== JSON.stringify(request)
      )
        throw new SenderError('Owner action ID was already used')
      return workActionStatus(db, existing)
    }
    const thread = threadInput(db, input.threadId)
    if (!thread) throw new SenderError('Thread is no longer available', 404)
    if (thread.modseq !== input.expectedRevision)
      throw new SenderError('The Thread changed. Refresh and retry.')
    const source = sourceLabel(db, thread.account_id, input.decision === 'not filtered')
    const messages = source ? matchingMessages(db, input.threadId, source) : []
    const sample = messages[0]
    if (!sample || (input.decision === 'filtered' && !thread.in_inbox))
      throw new SenderError('The Thread is no longer in the source mailbox')
    if (
      db
        .prepare(`
      SELECT 1 FROM message m JOIN screening_work w ON w.message_id = m.id
      JOIN owner_action a ON a.id = w.action_id
      WHERE m.thread_id = ? AND a.kind LIKE 'filter:%' AND w.status = 'pending'
    `)
        .get(input.threadId)
    )
      throw new SenderError('A filter action is already queued for this Thread')
    enqueue(
      db,
      id,
      thread.account_id,
      principal.tokenId,
      OWNER,
      request,
      messages.map(({ id }) => id),
    )
    annotate(db, {
      actionId: id,
      accountId: thread.account_id,
      threadId: input.threadId,
      mid: sample.id,
      label: input.decision,
      source:
        input.decision === 'not filtered'
          ? 'restore-from-filtered'
          : (input.source ?? 'thread-action'),
      error: input.decision === 'filtered' ? 'false-negative' : undefined,
      restore: input.decision === 'not filtered',
      reason,
    })
    return workActionStatus(db, {
      id,
      account_id: thread.account_id,
      kind: OWNER,
      undo_requested_at: null,
    })
  })
}

export function filterActions(
  store: MailStore,
  kick: () => void,
): Record<string, OwnerActionHandler> {
  const { db } = store
  const get = (id: string) => {
    const row = filterAction(db, id)
    if (!row) throw new SenderError('Owner action unavailable', 404)
    return workActionStatus(db, row)
  }
  const handler: OwnerActionHandler = {
    get,
    undo(principal, id) {
      const result = transaction(db, () => {
        assertOwner(db, principal)
        db.prepare(`
          UPDATE owner_action SET undo_requested_at = coalesce(undo_requested_at, ?), undo_token_id = ?
          WHERE id = ?
        `).run(Date.now(), principal.tokenId, id)
        annotateFilterUndo(db, id)
        return get(id)
      })
      kick()
      return result
    },
  }
  return { [OWNER]: handler, [AUTO]: handler }
}

// A structured attention assessment is required in addition to model confidence.
// These independent envelope and content checks err on the side of leaving mail in Inbox.
const protectedContent =
  /\b(?:secur(?:ity|e)|account|password|passcode|login|log[ -]?in|sign[ -]?in|verification|verify|otp|2fa|mfa|fraud|suspicious|urgent|immediately|breach|compromised|unauthori[sz]ed|recovery|authentication)\b/i

function canAutoFilter(store: MailStore, accountId: string, threadId: string, mid: string) {
  const { db } = store
  const source = db
    .prepare(`
    SELECT i.address, m.subject, m.snippet, m.delivered_at
    FROM message m JOIN sender_index i ON i.message_id = m.id
    JOIN sender_scan s ON s.account_id = i.account_id AND s.ready = 1
    JOIN account a ON a.id = m.account_id
    WHERE m.id = ? AND i.in_inbox = 1
      AND m.account_id || ':IMPORTANT' NOT IN (SELECT value FROM json_each(m.provider_label_ids))
      AND (a.kind = 'gmail' OR json_extract(a.cursor, '$.imapMoves') = 1)
      AND NOT EXISTS (
        SELECT 1 FROM sender_rule r WHERE r.account_id = i.account_id AND r.address = i.address
          AND (r.decision = 'block' OR (r.decision = 'accept' AND EXISTS (
            SELECT 1 FROM sender_evidence e WHERE e.account_id = i.account_id AND e.address = i.address
          )))
      )
  `)
    .get(mid)
  if (
    !source ||
    isOwnerAddress(store, String(source.address)) ||
    protectedContent.test(`${source.address} ${source.subject} ${source.snippet}`)
  )
    return false
  const age = Date.now() - Number(source.delivered_at)
  const thread = threadInput(db, threadId)
  if (
    age < 0 ||
    age > TRIAGE_RECENT_WINDOW_MS ||
    thread?.input_id !== mid ||
    thread.handled_id === mid ||
    thread.bucket !== null
  )
    return false
  if (!hasPositiveFilterExample(db, accountId)) return false
  const messages = matchingMessages(db, threadId, labelId(accountId, 'INBOX'))
  return messages.length === 1 && messages[0]?.id === mid
}

export function suggestFilter(
  store: MailStore,
  accountId: string,
  threadId: string,
  mid: string,
  decision: TriageBucketResult,
) {
  const { db } = store
  const previous = db
    .prepare(`
    SELECT 1 FROM screening_work w JOIN owner_action a ON a.id = w.action_id
    WHERE w.message_id = ? AND a.kind IN ('filter:review', 'filter:automatic')
  `)
    .get(mid)
  let actionId: string | undefined
  if (
    !previous &&
    decision.confidence === 'high' &&
    decision.attention === 'routine' &&
    canAutoFilter(store, accountId, threadId, mid)
  ) {
    actionId = randomUUID()
    enqueue(db, actionId, accountId, 'engine', AUTO, { threadId }, [mid])
  }
  recordPrediction(db, accountId, threadId, mid, 'filtered', decision, actionId)
  db.prepare('UPDATE thread SET filter_suggestion_message_id = ? WHERE id = ?').run(mid, threadId)
  store.recordChange('thread', threadId, 'upsert')
  return { updated: true }
}

export function filterWorkAllowed(store: MailStore, id: string, mid: string) {
  const { db } = store
  const action = filterAction(db, id)
  if (
    !action ||
    action.undo_requested_at !== null ||
    db
      .prepare(`
    SELECT 1 FROM screening_work WHERE action_id = ? AND message_id = ? AND undo_error IS NOT NULL
  `)
      .get(id, mid)
  )
    return false
  const { decision, threadId } = JSON.parse(action.request) as FilterReviewInput
  const source = sourceLabel(db, action.account_id, decision === 'not filtered')
  if (
    !source ||
    !db
      .prepare(`
    SELECT 1 FROM message m JOIN account a ON a.id = m.account_id
    WHERE m.id = ? AND m.thread_id = ? AND ${eligibleMail}
      AND ? IN (SELECT value FROM json_each(${providerMembership}))
  `)
      .get(mid, threadId, source)
  )
    return false
  return action.kind === AUTO
    ? canAutoFilter(store, action.account_id, threadId, mid)
    : liveOwner(db, action.token_id)
}

export function markRestored(store: MailStore, actionId: string, threadId: string, mid: string) {
  const thread = threadInput(store.db, threadId)
  if (thread?.input_id === mid && thread.handled_id !== mid) {
    markHandled(store.db, threadId, { action_id: actionId, message_id: mid })
    store.recordChange('thread', threadId, 'upsert')
  }
}

export function listFiltered(
  db: Db,
  accountId: string | undefined,
  cursor: string | undefined,
  limit: number,
  threadId?: string,
): FilteredPage {
  const rows = db
    .prepare(`
    SELECT t.id, t.account_id AS accountId, t.modseq AS revision
    FROM thread t JOIN filtered_destination d ON d.account_id = t.account_id
    WHERE (?1 IS NULL OR t.account_id = ?1) AND t.id > ?2
      AND (?4 IS NULL OR t.id = ?4)
      AND t.account_id || ':' || d.provider_id IN (SELECT value FROM json_each(t.label_ids))
    ORDER BY t.id LIMIT ?3
  `)
    .all(accountId ?? null, cursor ?? '', limit + 1, threadId ?? null) as FilteredPage['threads']
  const threads = rows.slice(0, limit)
  return { threads, cursor: rows.length > limit ? (threads.at(-1)?.id ?? null) : null }
}
