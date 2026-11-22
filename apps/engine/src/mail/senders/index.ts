import { domainToASCII } from 'node:url'
import type { Address } from '@amc/protocol'
import { transaction } from '../../db/database.ts'
import type { MailStore } from '../store.ts'

export function normalizeSender(input: string | null | undefined): string | null {
  if (!input) return null
  const at = input.lastIndexOf('@')
  if (at < 1) return null
  const local = input.slice(0, at)
  if (
    !/^[\p{L}\p{M}\p{N}!#$%&'*+\-/=?^_`{|}~]+(?:\.[\p{L}\p{M}\p{N}!#$%&'*+\-/=?^_`{|}~]+)*$/u.test(
      local,
    )
  )
    return null
  const rawDomain = input.slice(at + 1)
  if (!/^[\p{L}\p{M}\p{N}.\u3002\uff0e\uff61-]+$/u.test(rawDomain)) return null
  const domain = domainToASCII(rawDomain)
  if (
    domain.length > 253 ||
    !domain.split('.').every((part) => /^[a-z0-9](?:[a-z0-9-]{0,61}[a-z0-9])?$/i.test(part))
  )
    return null
  return `${local.toLowerCase()}@${domain.toLowerCase()}`
}

export function isOwnerAddress(store: MailStore, sender: string): boolean {
  return store.db
    .prepare('SELECT address FROM account')
    .all()
    .some(({ address }) => normalizeSender(String(address)) === sender)
}

export const senderStatusSql = `CASE
  WHEN r.decision = 'block' THEN 'blocked'
  WHEN r.decision = 'accept' THEN 'known'
  WHEN NOT EXISTS (SELECT 1 FROM sender_scan s WHERE s.account_id = i.account_id AND s.ready = 1)
    THEN 'unresolved'
  WHEN EXISTS (SELECT 1 FROM sender_evidence e WHERE e.account_id = i.account_id AND e.address = i.address)
    THEN 'known'
  ELSE 'new' END`

export function notifySenderThreads(store: MailStore, accountId: string, address?: string) {
  const rows = store.db
    .prepare(`
    SELECT DISTINCT m.thread_id AS id
    FROM sender_index i JOIN message m ON m.id = i.message_id
    WHERE i.account_id = ? AND i.in_inbox = 1 ${address === undefined ? '' : 'AND i.address = ?'}
  `)
    .all(...(address === undefined ? [accountId] : [accountId, address]))
  for (const row of rows) store.recordChange('thread', String(row.id), 'upsert')
}

export function enqueueScreening(
  store: MailStore,
  accountId: string,
  address: string,
  mid?: string,
) {
  const { db } = store
  const added = db
    .prepare(`
    INSERT INTO screening_work (action_id, identity, message_id)
    SELECT r.action_id, CASE WHEN a.kind = 'imap' THEN m.imap_fingerprint ELSE i.message_id END, i.message_id
    FROM sender_index i JOIN sender_rule r USING (account_id, address)
      JOIN message m ON m.id = i.message_id JOIN account a ON a.id = i.account_id
    WHERE i.account_id = ? AND i.address = ? AND i.in_inbox = 1 AND r.decision = 'block'
      AND (a.kind = 'gmail' OR m.imap_fingerprint IS NOT NULL)
      ${mid === undefined ? '' : 'AND i.message_id = ?'}
    ON CONFLICT (action_id, identity) DO UPDATE SET message_id = excluded.message_id
      WHERE screening_work.mutation_id IS NULL AND screening_work.status = 'pending'
        AND screening_work.message_id != excluded.message_id
        AND NOT EXISTS (SELECT 1 FROM message WHERE id = screening_work.message_id)
    RETURNING message_id
  `)
    .all(...(mid === undefined ? [accountId, address] : [accountId, address, mid]))
  for (const row of added) store.recordChange('message', String(row.message_id), 'upsert')
}

/** Called with observed provider membership, before the sync cursor can advance. */
export function observeSender(
  store: MailStore,
  mid: string,
  labels: readonly string[],
  ownAddresses: readonly string[] = [],
  scan = false,
) {
  const { db } = store
  const m = db
    .prepare(`
    SELECT m.account_id, m.from_json, m.to_json, m.cc_json, m.bcc_json, m.rfc_message_id, a.address
    FROM message m JOIN account a ON a.id = m.account_id WHERE m.id = ?
  `)
    .get(mid) as
    | {
        account_id: string
        from_json: string
        to_json: string
        cc_json: string
        bcc_json: string
        rfc_message_id: string | null
        address: string
      }
    | undefined
  if (!m) return
  const account = m.account_id
  const from = normalizeSender((JSON.parse(m.from_json) as Address | null)?.address)
  const owner =
    from &&
    ((m.address && normalizeSender(m.address) === from) ||
      ownAddresses.some((address) => normalizeSender(address) === from) ||
      isOwnerAddress(store, from))
  const is = (label: string) => labels.includes(`${account}:${label}`)
  const incoming = is('INBOX') && !['SPAM', 'TRASH', 'DRAFT', 'SENT'].some(is)
  if (from && !owner) {
    db.prepare(`
      INSERT INTO sender_index VALUES (?, ?, ?, ?)
      ON CONFLICT (message_id) DO UPDATE SET address = excluded.address, in_inbox = excluded.in_inbox
      WHERE address != excluded.address OR in_inbox != excluded.in_inbox
    `).run(mid, account, from, Number(incoming))
    if (incoming && !scan) enqueueScreening(store, account, from, mid)
  } else {
    db.prepare('DELETE FROM sender_index WHERE message_id = ?').run(mid)
  }

  if (!is('SENT') || ['SPAM', 'TRASH', 'DRAFT'].some(is)) return
  const identity = m.rfc_message_id?.trim() || mid
  const insert = db.prepare('INSERT OR IGNORE INTO sender_evidence VALUES (?, ?, ?)')
  for (const raw of [m.to_json, m.cc_json, m.bcc_json]) {
    for (const recipient of JSON.parse(raw) as Address[]) {
      const address = normalizeSender(recipient.address)
      if (!address) continue
      const known = db
        .prepare('SELECT 1 FROM sender_evidence WHERE account_id = ? AND address = ?')
        .get(account, address)
      if (insert.run(account, address, identity).changes && !known && !scan)
        notifySenderThreads(store, account, address)
    }
  }
}

/** Existing envelopes are indexed in restartable pages. Historic Sent only contributes evidence. */
export function scanSenderEnvelopes(store: MailStore) {
  const { db } = store
  transaction(db, () => {
    db.exec('INSERT OR IGNORE INTO sender_scan (account_id) SELECT id FROM account')
    const scans = db
      .prepare('SELECT account_id, cursor FROM sender_scan WHERE ready = 0')
      .all() as {
      account_id: string
      cursor: string
    }[]
    for (const { account_id: account, cursor } of scans) {
      const rows = db
        .prepare(`
        SELECT id, provider_id
        FROM message WHERE account_id = ? AND provider_id > ?
        ORDER BY provider_id LIMIT 200
      `)
        .all(account, cursor) as { id: string; provider_id: string }[]
      for (const row of rows) {
        const labels = observedLabels(store, row.id)
        observeSender(store, row.id, labels, [], true)
        const sender = db
          .prepare('SELECT address FROM sender_index WHERE message_id = ? AND in_inbox = 1')
          .get(row.id)
        // A rule applied during the scan still covers mail already in the Inbox.
        if (sender) enqueueScreening(store, account, String(sender.address), row.id)
      }
      const last = rows.at(-1)
      db.prepare(`UPDATE sender_scan SET cursor = ?, ready = ? WHERE account_id = ?`).run(
        last?.provider_id ?? cursor,
        Number(rows.length < 200),
        account,
      )
      if (rows.length < 200) notifySenderThreads(store, account)
    }
  })
}

export function observedLabels(store: MailStore, mid: string): string[] {
  const m = store.db
    .prepare(`
    SELECT a.kind, m.label_ids, m.provider_label_ids FROM message m JOIN account a ON a.id = m.account_id
    WHERE m.id = ?
  `)
    .get(mid)
  if (!m) return []
  if (m.kind === 'imap') {
    const locations = store.db
      .prepare('SELECT DISTINCT label_id FROM imap_location WHERE message_id = ?')
      .all(mid)
    if (locations.length) return locations.map(({ label_id }) => String(label_id))
  }
  return JSON.parse(String(m.provider_label_ids ?? m.label_ids)) as string[]
}
