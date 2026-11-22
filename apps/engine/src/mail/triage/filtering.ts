import type { FilteredPage, FilterReviewInput } from '@amc/protocol'
import type { Principal } from '../../auth/tokens.ts'
import { type Db, transaction } from '../../db/database.ts'
import type { OwnerActionHandler } from '../../http/senders.ts'
import { assertOwner, liveOwner, SenderError, workActionStatus } from '../senders/actions.ts'
import { labelId, type MailStore } from '../store.ts'
import { annotate, annotateUndo, arrivalKey, generation, ownerReasonRetry } from './annotations.ts'
import { markHandled, threadInput } from './input.ts'

const OWNER = 'filter:review'
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
    FROM owner_action WHERE id = ? AND kind = 'filter:review'
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

function sameRequest(saved: string, request: object) {
  const { mailboxGeneration: _, ...original } = JSON.parse(saved)
  return JSON.stringify(original) === JSON.stringify(request)
}

function filterStatus(db: Db, action: Parameters<typeof workActionStatus>[1]) {
  const rows = db
    .prepare('SELECT message_id FROM screening_work WHERE action_id = ? ORDER BY rowid')
    .all(action.id)
  return {
    ...workActionStatus(db, action),
    acceptedTargets: rows.map((row) => String(row.message_id)),
  }
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
        !sameRequest(existing.request, request)
      )
        throw new SenderError('Owner action ID was already used')
      ownerReasonRetry(db, id, reason, true)
      return filterStatus(db, existing)
    }
    const thread = threadInput(db, input.threadId)
    if (!thread) throw new SenderError('Thread is no longer available', 404)
    if (thread.modseq !== input.expectedRevision)
      throw new SenderError('The Thread changed. Refresh and retry.')
    if (
      input.predictionId &&
      (input.decision !== 'filter.filtered' ||
        !db
          .prepare(`
      SELECT 1 FROM thread WHERE id = ? AND filter_suggestion_event_id = ?
        AND filter_suggestion_message_id = ?
    `)
          .get(input.threadId, input.predictionId, thread.input_id))
    )
      throw new SenderError('The displayed Filter suggestion changed. Refresh and retry.')
    const source = sourceLabel(db, thread.account_id, input.decision === 'filter.keep')
    const available = source ? matchingMessages(db, input.threadId, source) : []
    const messages = input.messageIds
      ? available.filter(({ id }) => input.messageIds?.includes(id))
      : available
    if (input.messageIds && messages.length !== input.messageIds.length)
      throw new SenderError('The exact message selection changed. Refresh and retry.')
    if (messages.some(({ id }) => !arrivalKey(db, id)))
      throw new SenderError('The exact IMAP message location could not be verified')
    if (!messages.length || (input.decision === 'filter.filtered' && !thread.in_inbox))
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
      { ...request, mailboxGeneration: generation(db, thread.account_id) },
      messages.map(({ id }) => id),
    )
    ownerReasonRetry(db, id, reason)
    let primaryReasonId: string | undefined
    for (const message of messages) {
      const eventId = annotate(db, {
        axis: 'filter',
        actionId: id,
        accountId: thread.account_id,
        threadId: input.threadId,
        mid: message.id,
        revision: input.expectedRevision,
        label: input.decision,
        source:
          input.decision === 'filter.keep'
            ? 'restore_filtered'
            : (input.source ?? 'thread-action').replace('-', '_'),
        restore: input.decision === 'filter.keep',
        predictionId: input.predictionId,
        primaryReasonId,
        reason: primaryReasonId ? undefined : reason,
      })
      primaryReasonId ??= eventId
    }
    return filterStatus(db, {
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
    return filterStatus(db, row)
  }
  const handler: OwnerActionHandler = {
    get,
    undo(principal, id) {
      const result = transaction(db, () => {
        assertOwner(db, principal)
        const row = filterAction(db, id)
        if (!row) throw new SenderError('Owner action unavailable', 404)
        if (JSON.parse(row.request).mailboxGeneration !== generation(db, row.account_id))
          throw new SenderError('Mailbox identity changed')
        if (row.undo_requested_at !== null) return get(id)
        db.prepare(`
          UPDATE owner_action SET undo_requested_at = coalesce(undo_requested_at, ?), undo_token_id = ?
          WHERE id = ?
        `).run(Date.now(), principal.tokenId, id)
        annotateUndo(db, id)
        return get(id)
      })
      kick()
      return result
    },
  }
  return { [OWNER]: handler }
}

export function suggestFilter(store: MailStore, threadId: string, mid: string, eventId: string) {
  store.db
    .prepare(
      'UPDATE thread SET filter_suggestion_message_id = ?, filter_suggestion_event_id = ? WHERE id = ?',
    )
    .run(mid, eventId, threadId)
  store.recordChange('thread', threadId, 'upsert')
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
  const { decision, threadId, mailboxGeneration } = JSON.parse(
    action.request,
  ) as FilterReviewInput & { mailboxGeneration: number }
  if (mailboxGeneration !== generation(db, action.account_id)) return false
  const source = sourceLabel(db, action.account_id, decision === 'filter.keep')
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
  const event = db
    .prepare(`
    SELECT arrival_key FROM triage_event WHERE action_id = ? AND message_id = ? AND kind = 'decision'
  `)
    .get(id, mid)
  return (
    !!event?.arrival_key &&
    event.arrival_key === arrivalKey(db, mid) &&
    liveOwner(db, action.token_id)
  )
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
    SELECT t.id, t.account_id AS accountId, t.modseq AS revision, t.account_id || ':' || d.provider_id AS destination
    FROM thread t JOIN filtered_destination d ON d.account_id = t.account_id
    WHERE (:accountId IS NULL OR t.account_id = :accountId) AND t.id > :cursor
      AND (:threadId IS NULL OR t.id = :threadId)
      AND d.state = 'ready'
      AND t.account_id || ':' || d.provider_id IN (SELECT value FROM json_each(t.label_ids))
    ORDER BY t.id LIMIT :limit
  `)
    .all({
      accountId: accountId ?? null,
      cursor: cursor ?? '',
      limit: limit + 1,
      threadId: threadId ?? null,
    }) as {
    id: string
    accountId: string
    revision: number
    destination: string
  }[]
  const threads = rows
    .slice(0, limit)
    .map(({ destination, ...thread }) => ({
      ...thread,
      labelId: 'filter.filtered' as const,
      placements: matchingMessages(db, thread.id, destination).map(({ id: messageId }) => {
        const receipt = db
          .prepare(`
        SELECT e.action_id AS actionId, e.source, w.status
        FROM triage_event e
        JOIN screening_work w ON w.action_id = e.action_id AND w.message_id = e.message_id
        JOIN mutation m ON m.id = w.mutation_id
        JOIN message mail ON mail.id = w.message_id
        JOIN account a ON a.id = e.account_id
        WHERE e.account_id = ? AND e.message_id = ? AND e.arrival_key = ?
          AND e.account_generation = a.mailbox_generation
          AND e.kind = 'decision' AND e.label_id = 'filter.filtered'
          AND EXISTS (
            SELECT 1 FROM json_each(m.write_journal) j, json_each(j.value, '$.applied') change,
              json_each(change.value, '$.revisions') revision
            WHERE change.value ->> 'message_id' = e.message_id AND revision.key = ?
              AND (
                revision.value = mail.provider_history_id
                OR (a.kind = 'imap' AND EXISTS (
                  SELECT 1 FROM imap_location l WHERE l.message_id = e.message_id
                    AND l.label_id = revision.key AND l.verified = 1
                    AND revision.value = json_array(l.path_key, l.validity, l.uid)
                ))
              )
          )
          AND NOT EXISTS (
            SELECT 1 FROM mutation u, json_each(u.write_journal) j
            WHERE u.id = w.undo_id AND json_array_length(j.value, '$.applied') > 0
          )
        ORDER BY e.seq DESC LIMIT 1
      `)
          .get(thread.accountId, messageId, arrivalKey(db, messageId), destination)
        return receipt
          ? {
              messageId,
              origin: 'owner' as const,
              actionId: String(receipt.actionId),
              source: String(receipt.source),
              status: String(receipt.status),
            }
          : { messageId, origin: 'unknown' as const }
      }),
    }))
    .filter(({ placements }) => placements.length > 0)
  return { threads, cursor: rows.length > limit ? (rows[limit - 1]?.id ?? null) : null }
}
