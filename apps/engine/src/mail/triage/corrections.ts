import { randomUUID } from 'node:crypto'
import {
  type BucketReviewInput,
  bucketLabels,
  type OwnerActionStatus,
  type OwnerBucketInput,
} from '@amc/protocol'
import type { z } from 'zod'
import type { Principal } from '../../auth/tokens.ts'
import { type Db, transaction } from '../../db/database.ts'
import type { OwnerActionHandler } from '../../http/senders.ts'
import type { FrozenMessage, Receipt } from '../outbox.ts'
import { assertOwner, SenderError } from '../senders/actions.ts'
import type { MailStore } from '../store.ts'
import { annotate, annotateUndo, ownerReasonRetry, readOwnerReason } from './annotations.ts'
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
  const { reason, reasonRevision } = readOwnerReason(db, id)
  return {
    actionId: id,
    accountId: row.account_id,
    kind: KIND,
    ownerReason: reason,
    reasonRevision,
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
    const { ownerReason, ...publicInput } = input
    const request = JSON.stringify(publicInput)
    const existing = correction(db, input.clientActionId)
    if (existing) {
      if (existing.request !== request || existing.token_id !== principal.tokenId)
        throw new SenderError('Owner action ID was already used')
      ownerReasonRetry(db, input.clientActionId, ownerReason, true)
      return status(db, input.clientActionId)
    }
    if (db.prepare('SELECT 1 FROM owner_action WHERE id = ?').get(input.clientActionId))
      throw new SenderError('Owner action ID was already used')

    const thread = threadInput(db, input.threadId)
    if (!thread) throw new SenderError('Thread is no longer available', 404)
    if (!thread.in_inbox || !thread.input_id || thread.modseq !== input.expectedRevision)
      throw new SenderError('The Inbox input changed. Refresh the Thread and retry.')
    if (
      input.predictionId &&
      (thread.bucket_input_message_id !== thread.input_id ||
        thread.bucket_producer !== input.predictionId)
    )
      throw new SenderError('The displayed Bucket prediction changed. Refresh and retry.')

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
      '{}',
      now,
    )
    ownerReasonRetry(db, input.clientActionId, ownerReason)
    annotate(db, {
      axis: 'bucket',
      revision: modseq,
      reason: ownerReason,
      actionId: input.clientActionId,
      accountId: account_id,
      threadId: input.threadId,
      mid: input_id,
      label: bucketLabels[input.bucket],
      predictionId: input.predictionId,
      source: 'triage_key',
    })
    return status(db, input.clientActionId)
  })
}

export function setOwnerBucket(store: MailStore, principal: Principal, input: OwnerBucketInput) {
  const { db } = store
  return transaction(db, () => {
    assertOwner(db, principal, input.ownerReason ? 'admin' : 'organize')
    const { ownerReason, ...publicInput } = input
    const request = JSON.stringify(publicInput)
    const id = input.clientActionId ?? randomUUID()
    const existing = db
      .prepare('SELECT kind, token_id, request FROM owner_action WHERE id = ?')
      .get(id)
    if (existing) {
      if (
        existing.kind !== 'bucket:manual' ||
        existing.token_id !== principal.tokenId ||
        existing.request !== request
      )
        throw new SenderError('Owner action ID was already used')
      ownerReasonRetry(db, id, ownerReason, true)
      return true
    }
    const thread = threadInput(db, input.threadId)
    if (!thread) return false
    if (input.expectedRevision !== undefined && input.expectedRevision !== thread.modseq)
      throw new SenderError('The Thread changed. Refresh and retry.')
    db.prepare(
      'INSERT INTO owner_action (id, account_id, token_id, kind, request, created_at) VALUES (?, ?, ?, ?, ?, ?)',
    ).run(id, thread.account_id, principal.tokenId, 'bucket:manual', request, Date.now())
    if (thread.in_inbox && thread.input_id) {
      markHandled(db, input.threadId, { message_id: thread.input_id, action_id: id })
    }
    ownerReasonRetry(db, id, ownerReason)
    annotate(db, {
      axis: 'bucket',
      actionId: id,
      accountId: thread.account_id,
      threadId: input.threadId,
      mid: thread.input_id ?? undefined,
      revision: thread.modseq,
      label: input.bucket ? bucketLabels[input.bucket] : 'bucket.clear',
      source: 'thread_action',
      reason: ownerReason,
    })
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
          if (current) annotateUndo(db, id)
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
