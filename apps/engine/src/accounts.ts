import type { AccountStatus } from '@amc/protocol'
import { newId } from './auth/secrets.ts'
import type { Sealer } from './crypto.ts'
import type { Db } from './db/database.ts'
import { transaction } from './db/database.ts'
import type { MailStore } from './mail/store.ts'
import type { AccountState, BackfillState, GmailCursor } from './providers/gmail/sync.ts'
import { type ImapCredentials, imapEndpoint } from './providers/imap/client.ts'

export interface AccountRow {
  id: string
  kind: 'gmail' | 'imap'
  address: string
  status: AccountStatus
  credentials: Uint8Array
}

export function listAccountRows(db: Db): AccountRow[] {
  return db
    .prepare('SELECT id, kind, address, status, credentials FROM account ORDER BY created_at')
    .all() as unknown as AccountRow[]
}

export function getAccountRow(db: Db, id: string): AccountRow | null {
  return (
    (db
      .prepare('SELECT id, kind, address, status, credentials FROM account WHERE id = ?')
      .get(id) as unknown as AccountRow | undefined) ?? null
  )
}

/** Adds a Gmail Account, or stores fresh credentials when the owner signs in to it again. */
export function upsertGmailAccount(
  db: Db,
  store: MailStore,
  sealer: Sealer,
  input: { address: string; credentials: unknown },
): { id: string; created: boolean } {
  return upsertAccount(db, store, sealer, 'gmail', input)
}

export class AccountConflict extends Error {}

export function upsertImapAccount(
  db: Db,
  store: MailStore,
  sealer: Sealer,
  input: { address: string; credentials: ImapCredentials },
): { id: string; created: boolean } {
  return upsertAccount(db, store, sealer, 'imap', input)
}

function upsertAccount(
  db: Db,
  store: MailStore,
  sealer: Sealer,
  kind: AccountRow['kind'],
  input: { address: string; credentials: unknown },
): { id: string; created: boolean } {
  return transaction(db, () => {
    const existing = db
      .prepare('SELECT id, kind, credentials FROM account WHERE address = ? COLLATE NOCASE')
      .get(input.address) as AccountRow | undefined
    if (existing && existing.kind !== kind) {
      throw new AccountConflict('This address belongs to an Account with a different provider')
    }
    if (existing && kind === 'imap') {
      const { imap: old } = sealer.open<ImapCredentials>(existing.credentials)
      const { imap } = input.credentials as ImapCredentials
      if (imapEndpoint(old) !== imapEndpoint(imap)) {
        const page = db.prepare('SELECT provider_id FROM message WHERE account_id = ? LIMIT 128')
        for (;;) {
          const messages = page.all(existing.id) as { provider_id: string }[]
          if (!messages.length) break
          for (const { provider_id } of messages) store.deleteMessage(existing.id, provider_id)
        }
        store.syncLabels(existing.id, [])
        db.prepare(
          "UPDATE account SET cursor = '{}', backfill = '{}', last_sync_at = NULL WHERE id = ?",
        ).run(existing.id)
      }
    }
    const sealed = sealer.seal(input.credentials)
    if (existing) {
      db.prepare(
        "UPDATE account SET credentials = ?, status = 'new', last_error = NULL WHERE id = ?",
      ).run(sealed, existing.id)
      store.recordChange('account', existing.id, 'upsert')
      return { id: existing.id, created: false }
    }
    const id = newId('acc')
    db.prepare(
      "INSERT INTO account (id, kind, address, credentials, status, created_at) VALUES (?, ?, ?, ?, 'new', ?)",
    ).run(id, kind, input.address, sealed, Date.now())
    store.recordChange('account', id, 'upsert')
    return { id, created: true }
  })
}

/** Updates status; only a status change is a synced change (last_sync_at is not). */
export function setAccountStatus(
  db: Db,
  store: MailStore,
  id: string,
  status: AccountStatus,
  error: string | null = null,
): void {
  const row = db.prepare('SELECT status, last_error FROM account WHERE id = ?').get(id) as
    | { status: string; last_error: string | null }
    | undefined
  if (!row || (row.status === status && row.last_error === error)) return
  db.prepare('UPDATE account SET status = ?, last_error = ? WHERE id = ?').run(status, error, id)
  store.recordChange('account', id, 'upsert')
}

export function touchAccountSync(db: Db, id: string): void {
  db.prepare('UPDATE account SET last_sync_at = ? WHERE id = ?').run(Date.now(), id)
}

export class DbAccountState implements AccountState {
  readonly accountId: string
  readonly ownAddresses: readonly string[]
  readonly #db: Db

  constructor(db: Db, accountId: string, ownAddresses: readonly string[]) {
    this.#db = db
    this.accountId = accountId
    this.ownAddresses = ownAddresses
  }

  cursor(): GmailCursor {
    return JSON.parse(
      (
        this.#db.prepare('SELECT cursor FROM account WHERE id = ?').get(this.accountId) as {
          cursor: string
        }
      ).cursor,
    )
  }

  saveCursor(cursor: GmailCursor): void {
    this.#db
      .prepare('UPDATE account SET cursor = ? WHERE id = ?')
      .run(JSON.stringify(cursor), this.accountId)
  }

  backfill(): BackfillState {
    return JSON.parse(
      (
        this.#db.prepare('SELECT backfill FROM account WHERE id = ?').get(this.accountId) as {
          backfill: string
        }
      ).backfill,
    )
  }

  saveBackfill(state: BackfillState): void {
    this.#db
      .prepare('UPDATE account SET backfill = ? WHERE id = ?')
      .run(JSON.stringify(state), this.accountId)
  }
}
