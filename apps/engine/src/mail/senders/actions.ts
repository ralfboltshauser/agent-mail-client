import { randomUUID } from 'node:crypto'
import {
  hasScope,
  type OwnerActionState,
  type OwnerActionStatus,
  type SenderDecision,
  type SenderList,
  type SenderListQuery,
  type SenderStatus,
} from '@amc/protocol'
import type { Principal } from '../../auth/tokens.ts'
import { type Db, transaction } from '../../db/database.ts'
import type { MailStore } from '../store.ts'
import {
  enqueueScreening,
  isOwnerAddress,
  normalizeSender,
  notifySenderThreads,
  senderStatusSql,
} from './index.ts'

export class SenderError extends Error {
  readonly status: 400 | 403 | 404 | 409 | 503
  constructor(message: string, status: SenderError['status'] = 409) {
    super(message)
    this.status = status
  }
}

export function liveOwner(db: Db, tokenId: string): boolean {
  return !!db
    .prepare(`
    SELECT 1 FROM token WHERE id = ? AND kind IN ('desktop', 'cli')
    AND revoked_at IS NULL AND (expires_at IS NULL OR expires_at > ?)
    AND account_id IS NULL AND thread_id IS NULL
    AND 'admin' IN (SELECT value FROM json_each(scopes))
  `)
    .get(tokenId, Date.now())
}

export function assertOwner(db: Db, principal: Principal) {
  if (
    !['desktop', 'cli'].includes(principal.kind) ||
    !hasScope(principal.scopes, 'admin') ||
    !liveOwner(db, principal.tokenId)
  )
    throw new SenderError('This action requires a paired owner Client', 403)
}

interface Rule {
  revision: number
  decision: 'accept' | 'block' | null
  action_id: string
}

interface Action {
  id: string
  account_id: string
  token_id: string
  kind: string
  request: string
  undo_requested_at: number | null
  undo_token_id: string | null
}

interface DecisionRecord {
  address: string
  decision: SenderDecision['decision']
  previous: Rule | undefined
  revision: number
}

function action(db: Db, id: string): Action | undefined {
  return db.prepare('SELECT * FROM owner_action WHERE id = ?').get(id) as Action | undefined
}

function rule(db: Db, accountId: string, address: string): Rule | undefined {
  return db
    .prepare(
      'SELECT revision, decision, action_id FROM sender_rule WHERE account_id = ? AND address = ?',
    )
    .get(accountId, address) as Rule | undefined
}

function saveRule(
  store: MailStore,
  accountId: string,
  address: string,
  decision: Rule['decision'],
  revision: number,
  actionId: string,
) {
  store.db
    .prepare(`
    INSERT INTO sender_rule VALUES (?, ?, ?, ?, ?, ?)
    ON CONFLICT (account_id, address) DO UPDATE SET decision = excluded.decision,
      revision = excluded.revision, action_id = excluded.action_id, decided_at = excluded.decided_at
  `)
    .run(accountId, address, decision, revision, actionId, Date.now())
  if (decision === 'block') enqueueScreening(store, accountId, address)
  notifySenderThreads(store, accountId, address)
}

function aggregate(states: (OwnerActionState | null)[], error: string | null): OwnerActionState {
  if (states.includes('pending')) return 'pending'
  if (states.includes('partial')) return 'partial'
  if (states.includes('failed') || error) return states.includes('applied') ? 'partial' : 'failed'
  if (states.includes('applied') && states.includes('superseded')) return 'partial'
  if (states.includes('superseded')) return 'superseded'
  return 'applied'
}

export function senderActionStatus(db: Db, id: string): OwnerActionStatus {
  const row = action(db, id)
  if (!row || !row.kind.startsWith('sender:'))
    throw new SenderError('Owner action unavailable', 404)
  const request = JSON.parse(row.request) as DecisionRecord
  const current = rule(db, row.account_id, request.address)
  const work = db
    .prepare(`
    SELECT w.mutation_id, coalesce(m.status, w.status) AS status,
      coalesce(m.error, w.error) AS error, w.undo_id, u.status AS undo_status, coalesce(u.error, w.undo_error) AS undo_error,
      EXISTS (SELECT 1 FROM json_each(m.write_journal) j WHERE json_array_length(j.value, '$.applied') > 0) AS applied,
      EXISTS (SELECT 1 FROM json_each(u.write_journal) j WHERE json_array_length(j.value, '$.superseded') > 0) AS undo_superseded,
      EXISTS (SELECT 1 FROM json_each(m.write_journal) j WHERE json_array_length(j.value, '$.superseded') > 0) AS superseded,
      EXISTS (SELECT 1 FROM json_each(u.write_journal) j WHERE json_array_length(j.value, '$.applied') > 0) AS undo_applied
    FROM screening_work w LEFT JOIN mutation m ON m.id = w.mutation_id LEFT JOIN mutation u ON u.id = w.undo_id
    WHERE w.action_id = ?
  `)
    .all(id) as {
    mutation_id: string | null
    status: OwnerActionState
    error: string | null
    undo_id: string | null
    undo_status: OwnerActionState | null
    undo_error: string | null
    applied: number
    superseded: number
    undo_superseded: number
    undo_applied: number
  }[]
  const destinationError =
    current?.action_id === id && current.decision === 'block'
      ? db
          .prepare(
            "SELECT error FROM screened_destination WHERE account_id = ? AND state = 'repair'",
          )
          .get(row.account_id)?.error
      : null
  const error =
    work.find((item) => item.error)?.error ?? (destinationError ? String(destinationError) : null)
  const status = aggregate(
    work.map((item) =>
      item.status === 'applied' && item.superseded
        ? item.applied
          ? 'partial'
          : 'superseded'
        : item.status,
    ),
    error,
  )
  const undoError =
    work.find((item) => item.undo_error)?.undo_error ??
    (row.undo_requested_at !== null &&
    work.some((item) => item.status === 'partial' || item.status === 'failed')
      ? 'One or more original provider changes could not be fully verified'
      : null)
  const undoStates = work.map((item): OwnerActionState | null => {
    if (item.undo_error && !item.undo_id) return 'failed'
    if (item.status === 'pending' || (item.applied && !item.undo_id)) return 'pending'
    if (item.undo_status === 'applied' && item.undo_superseded)
      return item.undo_applied ? 'partial' : 'superseded'
    return item.undo_status
  })
  return {
    actionId: id,
    accountId: row.account_id,
    kind: row.kind,
    ...(request.revision === undefined ? {} : { revision: current?.revision ?? request.revision }),
    status: current?.action_id !== id && !work.length ? 'superseded' : status,
    error,
    mutationIds: work.flatMap(({ mutation_id }) => (mutation_id ? [mutation_id] : [])),
    undo:
      row.undo_requested_at === null
        ? null
        : {
            error: undoError,
            status: aggregate(undoStates, undoError),
            mutationIds: work.flatMap(({ undo_id }) => (undo_id ? [undo_id] : [])),
          },
  }
}

export function decideSender(store: MailStore, principal: Principal, input: SenderDecision) {
  const { db } = store
  return transaction(db, () => {
    assertOwner(db, principal)
    const address = normalizeSender(input.address)
    if (!address) throw new SenderError('Choose a single Sender address', 400)
    const { accountId, clientActionId, decision, expectedRevision } = input
    const existing = action(db, clientActionId)
    if (existing) {
      const request = JSON.parse(existing.request) as DecisionRecord
      if (
        existing.token_id !== principal.tokenId ||
        existing.account_id !== accountId ||
        existing.kind !== 'sender:decision' ||
        request.address !== address ||
        request.decision !== decision ||
        request.revision !== expectedRevision + 1
      )
        throw new SenderError('Client action ID is already in use')
      return senderActionStatus(db, clientActionId)
    }
    const account = db.prepare('SELECT kind, cursor FROM account WHERE id = ?').get(accountId)
    if (!account) throw new SenderError('Account unavailable', 404)
    if (decision !== 'clear' && isOwnerAddress(store, address))
      throw new SenderError('The owner’s addresses cannot be screened', 400)
    if (
      decision === 'block' &&
      account.kind === 'imap' &&
      !JSON.parse(String(account.cursor)).imapMoves
    )
      throw new SenderError('This IMAP Account does not support safe moves')
    const previous = rule(db, accountId, address)
    if ((previous?.revision ?? 0) !== expectedRevision)
      throw new SenderError('Sender rule changed. Refresh and retry.')
    const revision = expectedRevision + 1
    db.prepare(
      'INSERT INTO owner_action (id, account_id, token_id, kind, request, created_at) VALUES (?, ?, ?, ?, ?, ?)',
    ).run(
      clientActionId,
      accountId,
      principal.tokenId,
      'sender:decision',
      JSON.stringify({ address, decision, previous, revision }),
      Date.now(),
    )
    saveRule(
      store,
      accountId,
      address,
      decision === 'clear' ? null : decision,
      revision,
      clientActionId,
    )
    return senderActionStatus(db, clientActionId)
  })
}

export function undoSender(store: MailStore, principal: Principal, id: string) {
  const { db } = store
  return transaction(db, () => {
    assertOwner(db, principal)
    const original = action(db, id)
    if (!original || original.kind !== 'sender:decision')
      throw new SenderError('Owner action unavailable', 404)
    if (original.undo_requested_at !== null) return senderActionStatus(db, id)
    const { address, decision, previous, revision } = JSON.parse(original.request) as DecisionRecord
    const current = rule(db, original.account_id, address)
    if (current?.action_id !== id && (decision !== 'block' || current?.decision === 'block'))
      throw new SenderError('Sender rule changed since this action')
    db.prepare('UPDATE owner_action SET undo_requested_at = ?, undo_token_id = ? WHERE id = ?').run(
      Date.now(),
      principal.tokenId,
      id,
    )
    if (current?.action_id === id) {
      const restored = randomUUID()
      db.prepare(
        'INSERT INTO owner_action (id, account_id, token_id, kind, request, created_at) VALUES (?, ?, ?, ?, ?, ?)',
      ).run(
        restored,
        original.account_id,
        principal.tokenId,
        'sender:restore',
        JSON.stringify({
          address,
          revision: revision + 1,
          decision: previous?.decision ?? 'clear',
        }),
        Date.now(),
      )
      saveRule(
        store,
        original.account_id,
        address,
        previous?.decision ?? null,
        revision + 1,
        restored,
      )
    }
    // Reproject immediately to stop suppressing notification candidates for canceled work.
    const rows = db
      .prepare(`
      SELECT w.message_id AS id FROM screening_work w JOIN message m ON m.id = w.message_id
      WHERE w.action_id = ? AND w.status = 'pending'
    `)
      .all(id)
    for (const row of rows) store.recordChange('message', String(row.id), 'upsert')
    return senderActionStatus(db, id)
  })
}

export function listSenders(db: Db, input: SenderListQuery): SenderList {
  let boundary: [string, string] = ['', '']
  if (input.cursor) {
    try {
      const parsed = JSON.parse(input.cursor)
      if (
        !Array.isArray(parsed) ||
        parsed.length !== 2 ||
        !parsed.every((value) => typeof value === 'string')
      )
        throw new Error()
      boundary = parsed as [string, string]
    } catch {
      throw new SenderError('Invalid Sender page cursor', 400)
    }
  }
  const rows = db
    .prepare(`
    WITH identities AS (
      SELECT account_id, address FROM sender_index WHERE in_inbox = 1
      UNION SELECT account_id, address FROM sender_rule
      UNION SELECT account_id, address FROM sender_suggestion
    ), senders AS (
      SELECT i.account_id AS accountId, i.address, coalesce(r.revision, 0) AS revision,
        ${senderStatusSql} AS status
      FROM identities i LEFT JOIN sender_rule r USING (account_id, address)
      WHERE (?1 IS NULL OR i.account_id = ?1) AND (i.account_id, i.address) > (?2, ?3)
    )
    SELECT * FROM senders WHERE (?4 IS NULL OR status = ?4)
    ORDER BY accountId, address LIMIT ?5
  `)
    .all({
      1: input.accountId ?? null,
      2: boundary[0],
      3: boundary[1],
      4: input.status ?? null,
      5: input.limit + 1,
    }) as { accountId: string; address: string; revision: number; status: SenderStatus }[]
  const page = rows.slice(0, input.limit)
  const last = page.at(-1)
  return {
    rows: page.map((row) => ({
      ...row,
      suggestions: db
        .prepare(`
        SELECT s.action_id AS actionId, a.token_name AS author, s.message_id AS messageId, s.decision, s.reason
        FROM sender_suggestion s JOIN agent_action a ON a.id = s.action_id
        WHERE s.account_id = ? AND s.address = ? ORDER BY a.seq DESC LIMIT 20
      `)
        .all(row.accountId, row.address) as unknown as SenderList['rows'][number]['suggestions'],
    })),
    cursor:
      last && rows.length > input.limit ? JSON.stringify([last.accountId, last.address]) : null,
  }
}
