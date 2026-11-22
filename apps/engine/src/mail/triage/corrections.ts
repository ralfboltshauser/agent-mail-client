import { randomUUID } from 'node:crypto'
import type { BucketInput, BucketReviewInput, OwnerActionStatus } from '@amc/protocol'
import type { z } from 'zod'
import type { Principal } from '../../auth/tokens.ts'
import { type Db, transaction } from '../../db/database.ts'
import type { OwnerActionHandler } from '../../http/senders.ts'
import type { FrozenMessage, Receipt } from '../outbox.ts'
import { assertOwner, SenderError } from '../senders/actions.ts'
import type { MailStore } from '../store.ts'
import { type Assignment, markHandled, threadInput, type Watermark } from './input.ts'

const KIND = 'bucket:review'
type Review = z.infer<typeof BucketReviewInput>

interface Previous {
  assignment: Assignment
  revision: string | null
  watermark?: Watermark
}

function correction(db: Db, id: string) {
  return db
    .prepare(`
    SELECT c.*, a.request, a.token_id FROM triage_correction c JOIN owner_action a ON a.id = c.action_id
    WHERE c.action_id = ?
  `)
    .get(id) as
    | {
        account_id: string
        thread_id: string
        request: string
        token_id: string
        applied_revision: string
        previous: string
        undo_status: 'applied' | 'superseded' | null
      }
    | undefined
}

function status(db: Db, id: string): OwnerActionStatus {
  const row = correction(db, id)
  if (!row) throw new SenderError('Owner action unavailable', 404)
  const thread = threadInput(db, row.thread_id)
  return {
    actionId: id,
    accountId: row.account_id,
    kind: KIND,
    status:
      row.undo_status === 'applied' || thread?.bucket_revision === row.applied_revision
        ? 'applied'
        : 'superseded',
    ...(thread ? { revision: thread.modseq } : {}),
    error: null,
    mutationIds: [],
    undo: row.undo_status
      ? {
          status: row.undo_status,
          error: row.undo_status === 'superseded' ? 'The Bucket changed after this review' : null,
          mutationIds: [],
        }
      : null,
  }
}

export function correctBucket(store: MailStore, principal: Principal, input: Review) {
  const { db } = store
  return transaction(db, () => {
    assertOwner(db, principal)
    const request = JSON.stringify(input)
    const existing = correction(db, input.clientActionId)
    if (existing) {
      if (existing.request !== request || existing.token_id !== principal.tokenId)
        throw new SenderError('Owner action ID was already used')
      return status(db, input.clientActionId)
    }
    if (db.prepare('SELECT 1 FROM owner_action WHERE id = ?').get(input.clientActionId))
      throw new SenderError('Owner action ID was already used')

    const thread = threadInput(db, input.threadId)
    if (!thread) throw new SenderError('Thread is no longer available', 404)
    if (!thread.in_inbox || !thread.input_id || thread.modseq !== input.expectedRevision)
      throw new SenderError('The Inbox input changed. Refresh the Thread and retry.')

    const {
      account_id,
      modseq,
      bucket_revision,
      input_id,
      in_inbox: _inbox,
      handled_id: _handled,
      ...assignment
    } = thread
    const watermark = db
      .prepare('SELECT message_id, action_id FROM owner_handled WHERE thread_id = ?')
      .get(input.threadId) as Watermark | undefined
    const previous: Previous = {
      assignment,
      revision: bucket_revision,
      ...(watermark ? { watermark } : {}),
    }
    const source = db
      .prepare(
        'SELECT substr(subject, 1, 240) AS subject, substr(snippet, 1, 480) AS snippet FROM message WHERE id = ?',
      )
      .get(input_id)
    const now = Date.now()
    db.prepare(
      'INSERT INTO owner_action (id, account_id, token_id, kind, request, created_at) VALUES (?, ?, ?, ?, ?, ?)',
    ).run(input.clientActionId, account_id, principal.tokenId, KIND, request, now)
    markHandled(db, input.threadId, { message_id: input_id, action_id: input.clientActionId })
    store.setBucket(input, 'owner')
    db.prepare(`
      INSERT INTO triage_correction (action_id, account_id, thread_id, message_id, input_revision,
        applied_revision, previous, chosen, summary, created_at)
      VALUES (?, ?, ?, ?, ?, (SELECT bucket_revision FROM thread WHERE id = ?), ?, ?, ?, ?)
    `).run(
      input.clientActionId,
      account_id,
      input.threadId,
      input_id,
      modseq,
      input.threadId,
      JSON.stringify(previous),
      input.bucket,
      JSON.stringify(source),
      now,
    )
    return status(db, input.clientActionId)
  })
}

export function setOwnerBucket(store: MailStore, principal: Principal, input: BucketInput) {
  const { db } = store
  return transaction(db, () => {
    const thread = threadInput(db, input.threadId)
    if (!thread) return false
    if (thread.in_inbox && thread.input_id) {
      const id = randomUUID()
      db.prepare(
        'INSERT INTO owner_action (id, account_id, token_id, kind, request, created_at) VALUES (?, ?, ?, ?, ?, ?)',
      ).run(
        id,
        thread.account_id,
        principal.tokenId,
        'bucket:manual',
        JSON.stringify(input),
        Date.now(),
      )
      markHandled(db, input.threadId, { message_id: thread.input_id, action_id: id })
    }
    return store.setBucket(input, 'owner')
  })
}

export function correctionActions(store: MailStore): Record<string, OwnerActionHandler> {
  const { db } = store
  return {
    [KIND]: {
      get: (id) => status(db, id),
      undo(principal, id) {
        return transaction(db, () => {
          assertOwner(db, principal)
          const row = correction(db, id)
          if (!row) throw new SenderError('Owner action unavailable', 404)
          if (row.undo_status) return status(db, id)
          const thread = threadInput(db, row.thread_id)
          const current = thread?.bucket_revision === row.applied_revision
          db.prepare(
            'UPDATE owner_action SET undo_requested_at = ?, undo_token_id = ? WHERE id = ?',
          ).run(Date.now(), principal.tokenId, id)
          db.prepare('UPDATE triage_correction SET undo_status = ? WHERE action_id = ?').run(
            current ? 'applied' : 'superseded',
            id,
          )
          if (current) {
            const { assignment, watermark, revision } = JSON.parse(row.previous) as Previous
            db.prepare(
              'UPDATE thread SET bucket = ?, bucket_reason = ?, bucket_set_by = ?, bucket_set_at = ? WHERE id = ?',
            ).run(
              assignment.bucket,
              assignment.bucket_reason,
              assignment.bucket_set_by,
              assignment.bucket_set_at,
              row.thread_id,
            )
            db.prepare(`
              UPDATE thread SET bucket_confidence = ?, bucket_input_revision = ?,
                bucket_input_message_id = ?, bucket_producer = ? WHERE id = ?
            `).run(
              assignment.bucket_confidence,
              assignment.bucket_input_revision,
              assignment.bucket_input_message_id,
              assignment.bucket_producer,
              row.thread_id,
            )
            // Preserve a later verified Reply's watermark.
            const erased = db
              .prepare('DELETE FROM owner_handled WHERE thread_id = ? AND action_id = ?')
              .run(row.thread_id, id)
            if (erased.changes && watermark) markHandled(db, row.thread_id, watermark)
            // A verified Reply can replace the watermark without changing the Bucket.
            db.prepare(`
              UPDATE triage_correction SET applied_revision = (SELECT bucket_revision FROM thread WHERE id = ?1)
              WHERE thread_id = ?1 AND applied_revision = ?2 AND undo_status IS NULL
            `).run(row.thread_id, revision)
            store.recordChange('thread', row.thread_id, 'upsert')
          }
          return status(db, id)
        })
      },
    },
  }
}

export function correctionExamples(db: Db, accountId: string) {
  const rows = db
    .prepare(`
    SELECT previous -> 'assignment' ->> 'bucket' AS previous, chosen, summary
    FROM triage_correction WHERE account_id = ? AND undo_status IS NULL
    ORDER BY created_at DESC, action_id DESC LIMIT 12
  `)
    .all(accountId)
  return rows.map(({ previous, chosen, summary }) => ({
    previous,
    chosen,
    context: JSON.parse(String(summary)) as { subject: string; snippet: string },
  }))
}

export function markConfirmedReply(
  store: MailStore,
  message: FrozenMessage,
  rfcId: string,
  receipt: Receipt,
) {
  if (!message.threadId || !message.inReplyTo || receipt.allRecipientsAccepted === false) return
  const { db } = store
  const row = threadInput(db, message.threadId)
  if (!row?.in_inbox || row.account_id !== message.accountId || !row.input_id) return
  const target = db
    .prepare("SELECT trim(rfc_message_id, '<>') AS rfc_id FROM message WHERE id = ?")
    .get(row.input_id)
  if (target?.rfc_id !== message.inReplyTo.replace(/^<|>$/g, '')) return
  const item = db
    .prepare("SELECT id FROM outbox WHERE account_id = ? AND rfc_id = ? AND status = 'sent'")
    .get(message.accountId, rfcId)
  if (!item) return
  const id = `reply:${item.id}`
  const inserted = db
    .prepare(`
    INSERT INTO owner_action (id, account_id, token_id, kind, request, created_at)
    VALUES (?, ?, 'outbox', 'bucket:reply', ?, ?) ON CONFLICT(id) DO NOTHING
  `)
    .run(
      id,
      message.accountId,
      JSON.stringify({ outboxId: item.id, messageId: row.input_id }),
      Date.now(),
    )
  if (!inserted.changes) return
  markHandled(db, message.threadId, { message_id: row.input_id, action_id: id })
  store.recordChange('thread', message.threadId, 'upsert')
}
