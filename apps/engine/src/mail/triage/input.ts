import type { BucketConfidence, BucketStorageKey } from '@amc/protocol'
import type { Db } from '../../db/database.ts'

// Keep the arrival identity independent of Sender parsing and Sent-evidence readiness.
export const latestInboxMessageSql = `(
  SELECT m.id FROM message m WHERE m.thread_id = t.id
    AND EXISTS (SELECT 1 FROM json_each(m.label_ids) WHERE value = m.account_id || ':INBOX')
    AND NOT EXISTS (SELECT 1 FROM json_each(m.label_ids)
      WHERE value IN (m.account_id || ':SENT', m.account_id || ':DRAFT',
        m.account_id || ':SPAM', m.account_id || ':TRASH'))
  ORDER BY coalesce(m.delivered_at, m.sent_at) DESC, m.id DESC LIMIT 1
)`

export interface Assignment {
  bucket: BucketStorageKey | null
  bucket_reason: string | null
  bucket_set_by: string | null
  bucket_set_at: number | null
  bucket_confidence: BucketConfidence | null
  bucket_input_revision: number | null
  bucket_input_message_id: string | null
  bucket_producer: string | null
}

export interface Watermark {
  message_id: string
  action_id: string
}

export function threadInput(db: Db, id: string) {
  return db
    .prepare(`
    SELECT t.account_id, t.modseq, t.bucket_revision, t.in_inbox,
      t.bucket, t.bucket_reason, t.bucket_set_by, t.bucket_set_at,
      t.bucket_confidence, t.bucket_input_revision, t.bucket_input_message_id, t.bucket_producer,
      ${latestInboxMessageSql} AS input_id, h.message_id AS handled_id
    FROM thread t LEFT JOIN owner_handled h ON h.thread_id = t.id WHERE t.id = ?
  `)
    .get(id) as
    | (Assignment & {
        account_id: string
        modseq: number
        bucket_revision: string | null
        in_inbox: number
        input_id: string | null
        handled_id: string | null
      })
    | undefined
}

export function markHandled(db: Db, threadId: string, mark: Watermark) {
  db.prepare(`
    INSERT INTO owner_handled (thread_id, message_id, action_id) VALUES (?, ?, ?)
    ON CONFLICT(thread_id) DO UPDATE SET message_id = excluded.message_id, action_id = excluded.action_id
  `).run(threadId, mark.message_id, mark.action_id)
}
