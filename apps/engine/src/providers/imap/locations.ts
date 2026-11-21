import type { FetchMessageObject } from 'imapflow'
import { newId } from '../../auth/secrets.ts'
import { transaction } from '../../db/database.ts'
import { type IncomingMessage, labelId, type MailStore, messageId } from '../../mail/store.ts'
import type { Folder } from './mapping.ts'
import { ImapThreads } from './threading.ts'

export interface Location {
  uid: number
  message_id: string
  label_id: string
  unread: number
  starred: number
  verified: number
  source_blob: string | null
}

export const PAGE = 32

export class ImapLocations {
  readonly #threads: ImapThreads

  readonly store: MailStore
  readonly accountId: string
  readonly address: string

  constructor(store: MailStore, accountId: string, address: string) {
    this.store = store
    this.accountId = accountId
    this.address = address
    this.#threads = new ImapThreads(store, accountId)
  }

  page(path: string, validity: string, after = 0, limit = PAGE): Location[] {
    return this.store.db
      .prepare(
        `SELECT uid, message_id, label_id, unread, starred, verified, source_blob FROM imap_location
       WHERE account_id = ? AND path_key = ? AND validity = ? AND uid > ? ORDER BY uid LIMIT ?`,
      )
      .all(
        this.accountId,
        encodeURIComponent(path),
        validity,
        after,
        limit,
      ) as unknown as Location[]
  }

  get(path: string, validity: string, uid: number): Location | undefined {
    return this.store.db
      .prepare(
        `SELECT uid, message_id, label_id, unread, starred, verified, source_blob FROM imap_location
       WHERE account_id = ? AND path_key = ? AND validity = ? AND uid = ?`,
      )
      .get(this.accountId, encodeURIComponent(path), validity, uid) as unknown as
      | Location
      | undefined
  }

  put(
    folder: Folder,
    validity: string,
    item: FetchMessageObject,
    message: IncomingMessage,
    sourceBlob: string,
  ): void {
    const { db } = this.store
    const { uid } = item
    transaction(db, () => {
      const old = this.get(folder.path, validity, uid)
      const duplicate = db
        .prepare(
          'SELECT id FROM message WHERE account_id = ? AND rfc_message_id IS ? AND imap_fingerprint = ? ORDER BY rowid LIMIT 1',
        )
        .get(this.accountId, message.rfcMessageId, sourceBlob) as { id: string } | undefined
      // Bind the first real Sent UID to the local copy published after SMTP acceptance.
      const submitted =
        folder.label.providerId === 'SENT' && message.rfcMessageId
          ? (db
              .prepare(
                "SELECT m.id FROM outbox o JOIN message m ON m.account_id = o.account_id AND m.provider_id = o.provider_id WHERE o.account_id = ? AND o.rfc_id = ? AND o.status = 'sent' AND m.imap_fingerprint IS NULL",
              )
              .get(this.accountId, message.rfcMessageId.replace(/^<|>$/g, '')) as
              | { id: string }
              | undefined)
          : undefined
      let mid: string
      if (duplicate) {
        mid = duplicate.id
      } else {
        const legacy =
          old?.source_blob === null &&
          db.prepare('SELECT imap_fingerprint FROM message WHERE id = ?').get(old.message_id)
            ?.imap_fingerprint === null
        if (submitted) message.providerId = submitted.id.slice(this.accountId.length + 1)
        else if (legacy) message.providerId = old.message_id.slice(this.accountId.length + 1)
        else if (this.store.hasMessage(this.accountId, message.providerId))
          message.providerId = newId('imap')
        mid = messageId(this.accountId, message.providerId)
        message.providerThreadId = this.#threads.assign(message, mid)
        this.store.putMessage(this.accountId, [this.address], message)
        db.prepare('UPDATE message SET imap_fingerprint = ? WHERE id = ?').run(sourceBlob, mid)
        this.#threads.remember(message, mid)
      }
      db.prepare(
        `INSERT INTO imap_location (account_id, path_key, validity, uid, message_id, label_id, unread, starred, source_blob)
         VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?)
         ON CONFLICT (account_id, path_key, validity, uid) DO UPDATE SET
           message_id = excluded.message_id, label_id = excluded.label_id, unread = excluded.unread,
           starred = excluded.starred, verified = 1, source_blob = excluded.source_blob`,
      ).run(
        this.accountId,
        encodeURIComponent(folder.path),
        validity,
        uid,
        mid,
        labelId(this.accountId, folder.label.providerId),
        Number(message.unread),
        Number(message.starred),
        sourceBlob,
      )
      this.#threads.restoreBucket(encodeURIComponent(folder.path), message, sourceBlob, mid)
      this.#refresh(mid)
      if (old && old.message_id !== mid) this.#refresh(old.message_id)
    })
  }

  remove(path: string, validity: string, uid: number): void {
    transaction(this.store.db, () => {
      const gone = this.store.db
        .prepare(
          'DELETE FROM imap_location WHERE account_id = ? AND path_key = ? AND validity = ? AND uid = ? RETURNING message_id',
        )
        .get(this.accountId, encodeURIComponent(path), validity, uid) as
        | { message_id: string }
        | undefined
      if (gone) this.#refresh(gone.message_id)
    })
  }

  clear(path: string, preserveBuckets = false): void {
    const { db } = this.store
    const key = encodeURIComponent(path)
    if (preserveBuckets) {
      // Location deletion cascades through the last message and its reference aliases.
      db.prepare(`
        WITH affected AS (
          SELECT DISTINCT t.id, t.provider_thread_id, t.bucket, t.bucket_reason,
                          t.bucket_set_by, t.bucket_set_at
          FROM imap_location l
          JOIN message m ON m.id = l.message_id
          JOIN thread t ON t.id = m.thread_id
          WHERE l.account_id = ?1 AND l.path_key = ?2 AND t.bucket IS NOT NULL
            AND NOT EXISTS (
              SELECT 1 FROM message other
              JOIN imap_location kept ON kept.message_id = other.id
              WHERE other.thread_id = t.id AND kept.path_key <> ?2
            )
        ), identities AS (
          SELECT t.id, 'rfc:' || a.rfc_id AS identity
          FROM affected t JOIN imap_thread_alias a ON a.thread_id = t.id
          UNION
          SELECT t.id, 'source:' || m.imap_fingerprint
          FROM affected t JOIN message m ON m.thread_id = t.id
          WHERE m.imap_fingerprint IS NOT NULL
        )
        INSERT OR REPLACE INTO imap_bucket_reimport
          (account_id, path_key, identity, thread_key, bucket, bucket_reason, bucket_set_by, bucket_set_at)
        SELECT ?1, ?2, i.identity, t.provider_thread_id, t.bucket, t.bucket_reason,
               t.bucket_set_by, t.bucket_set_at
        FROM affected t JOIN identities i ON i.id = t.id
      `).run(this.accountId, key)
    } else {
      this.finishReimport(path)
    }
    const next = db.prepare(
      'SELECT validity, uid FROM imap_location WHERE account_id = ? AND path_key = ? LIMIT ?',
    )
    let rows: { validity: string; uid: number }[]
    do {
      rows = next.all(this.accountId, key, PAGE) as typeof rows
      for (const { validity, uid } of rows) this.remove(path, validity, uid)
    } while (rows.length)
  }

  finishReimport(path: string): void {
    this.store.db
      .prepare('DELETE FROM imap_bucket_reimport WHERE account_id = ? AND path_key = ?')
      .run(this.accountId, encodeURIComponent(path))
  }

  flags(path: string, validity: string, uid: number, unread: boolean, starred: boolean): void {
    transaction(this.store.db, () => {
      const row = this.store.db
        .prepare(
          `UPDATE imap_location SET unread = ?, starred = ?
         WHERE account_id = ? AND path_key = ? AND validity = ? AND uid = ?
           AND (unread != ? OR starred != ?) RETURNING message_id`,
        )
        .get(
          +unread,
          +starred,
          this.accountId,
          encodeURIComponent(path),
          validity,
          uid,
          +unread,
          +starred,
        ) as { message_id: string } | undefined
      if (row) this.#refresh(row.message_id)
    })
  }

  relabel(path: string, folder: Folder): void {
    const { db } = this.store
    const oldPath = encodeURIComponent(path)
    const newPath = encodeURIComponent(folder.path)
    const label = labelId(this.accountId, folder.label.providerId)
    if (oldPath !== newPath)
      db.prepare(
        'UPDATE imap_bucket_reimport SET path_key = ? WHERE account_id = ? AND path_key = ?',
      ).run(newPath, this.accountId, oldPath)
    // The caller updates Labels, locations and the saved cursor in one transaction.
    const mismatched = db.prepare(
      `SELECT DISTINCT message_id FROM imap_location
       WHERE account_id = ? AND path_key = ? AND (path_key != ? OR label_id != ?)
         AND message_id > ? ORDER BY message_id LIMIT ?`,
    )
    let after = ''
    for (;;) {
      const rows = mismatched.all(this.accountId, oldPath, newPath, label, after, PAGE) as {
        message_id: string
      }[]
      if (!rows.length) return
      for (const { message_id } of rows) {
        db.prepare(
          'UPDATE imap_location SET path_key = ?, label_id = ? WHERE account_id = ? AND path_key = ? AND message_id = ?',
        ).run(newPath, label, this.accountId, oldPath, message_id)
        this.#refresh(message_id)
        after = message_id
      }
    }
  }

  #refresh(mid: string): void {
    const { db } = this.store
    const { labels, unread, starred } = db
      .prepare(
        `SELECT json_group_array(DISTINCT label_id ORDER BY label_id) AS labels,
         max(unread) AS unread, max(starred) AS starred FROM imap_location WHERE message_id = ?`,
      )
      .get(mid) as { labels: string; unread: number | null; starred: number | null }
    if (unread === null) {
      this.store.deleteMessage(this.accountId, mid.slice(this.accountId.length + 1))
      return
    }
    const changed = db
      .prepare(
        `UPDATE message SET label_ids = ?, unread = ?, starred = ?
       WHERE id = ? AND (label_ids != ? OR unread != ? OR starred != ?) RETURNING thread_id`,
      )
      .get(labels, unread, starred, mid, labels, unread, starred) as
      | { thread_id: string }
      | undefined
    if (changed) {
      this.store.recordChange('message', mid, 'upsert')
      this.store.refreshThread(changed.thread_id)
    }
  }
}
