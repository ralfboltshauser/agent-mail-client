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
  arrival_key: string | null
}

export interface MessageLocation extends Location {
  path_key: string
  validity: string
}

export const PAGE = 32

// A merged message card must have exactly one verified Drafts location.
export const imapDraftRevisionSql = `(
  SELECT CASE WHEN count(*) = 1 AND min(l.verified) = 1 THEN
    max(json_array(a.mailbox_generation, l.path_key, l.validity, l.uid, l.source_blob))
  END
  FROM imap_location l JOIN account a ON a.id = l.account_id
  WHERE l.message_id = m.id AND l.account_id = m.account_id
    AND l.label_id = m.account_id || ':DRAFT' AND a.kind = 'imap'
)`

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
        `SELECT uid, message_id, label_id, unread, starred, verified, source_blob, arrival_key FROM imap_location
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
        `SELECT uid, message_id, label_id, unread, starred, verified, source_blob, arrival_key FROM imap_location
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
           arrival_key = CASE WHEN imap_location.message_id = excluded.message_id
             AND imap_location.source_blob IS excluded.source_blob
             THEN imap_location.arrival_key ELSE lower(hex(randomblob(16))) END,
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
          `DELETE FROM imap_location WHERE account_id = ? AND path_key = ? AND validity = ? AND uid = ?
         AND NOT EXISTS (
           SELECT 1 FROM mutation m, json_each(m.write_journal) j
           WHERE m.account_id = imap_location.account_id AND m.status = 'pending'
             AND json_extract(j.value, '$.pending.move.source.message_id') = imap_location.message_id
             AND json_extract(j.value, '$.pending.move.source.path_key') = imap_location.path_key
             AND json_extract(j.value, '$.pending.move.source.validity') = imap_location.validity
             AND json_extract(j.value, '$.pending.move.source.uid') = imap_location.uid
         ) RETURNING message_id`,
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
      'SELECT rowid, validity, uid FROM imap_location WHERE account_id = ? AND path_key = ? AND rowid > ? ORDER BY rowid LIMIT ?',
    )
    let after = 0
    for (;;) {
      const rows = next.all(this.accountId, key, after, PAGE) as {
        rowid: number
        validity: string
        uid: number
      }[]
      if (!rows.length) return
      for (const { rowid, validity, uid } of rows) {
        this.remove(path, validity, uid)
        after = rowid
      }
    }
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
      if (row) this.#refresh(row.message_id, false)
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

  forMessage(mid: string): MessageLocation[] {
    return this.store.db
      .prepare('SELECT * FROM imap_location WHERE account_id = ? AND message_id = ?')
      .all(this.accountId, mid) as unknown as MessageLocation[]
  }

  moved(
    source: MessageLocation,
    destination: Folder,
    validity: string,
    uid: number,
    flags: {
      unread: boolean
      starred: boolean
    },
  ): void {
    this.store.db
      .prepare(`
      UPDATE imap_location SET path_key = ?, validity = ?, uid = ?, label_id = ?, unread = ?, starred = ?
      WHERE account_id = ? AND path_key = ? AND validity = ? AND uid = ?`)
      .run(
        encodeURIComponent(destination.path),
        validity,
        uid,
        labelId(this.accountId, destination.label.providerId),
        Number(flags.unread),
        Number(flags.starred),
        this.accountId,
        source.path_key,
        source.validity,
        source.uid,
      )
    this.#refresh(source.message_id)
  }

  inheritArrival(
    source: MessageLocation,
    destination: Folder,
    validity: string,
    uid: number,
  ): void {
    if (!source.arrival_key) return
    this.store.db
      .prepare(`
      UPDATE imap_location SET arrival_key = ?
      WHERE account_id = ? AND path_key = ? AND validity = ? AND uid = ? AND message_id = ?
    `)
      .run(
        source.arrival_key,
        this.accountId,
        encodeURIComponent(destination.path),
        validity,
        uid,
        source.message_id,
      )
  }

  #refresh(mid: string, locationsChanged = true): void {
    const { db } = this.store
    if (!db.prepare('SELECT 1 FROM imap_location WHERE message_id = ? LIMIT 1').get(mid)) {
      this.store.deleteMessage(this.accountId, mid.slice(this.accountId.length + 1))
      return
    }
    if (this.store.refreshMessageLabels(mid)) {
      const row = db.prepare('SELECT thread_id FROM message WHERE id = ?').get(mid) as {
        thread_id: string
      }
      this.store.refreshThread(row.thread_id)
    } else if (
      locationsChanged &&
      db
        .prepare(
          'SELECT 1 FROM message WHERE id = ? AND ? IN (SELECT value FROM json_each(label_ids))',
        )
        .get(mid, labelId(this.accountId, 'DRAFT'))
    ) {
      // Different locations can leave the same deduplicated card and labels in place.
      this.store.recordChange('message', mid, 'upsert')
    }
  }
}
