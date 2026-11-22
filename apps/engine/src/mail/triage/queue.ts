import type { TriageQueuePage, TriageQueueQuery } from '@amc/protocol'
import { z } from 'zod'
import { type Db, transaction } from '../../db/database.ts'
import { SenderError, senderSuggestions } from '../senders/actions.ts'
import { senderStatusSql } from '../senders/index.ts'
import { latestInboxMessageSql } from './input.ts'

const Cursor = z.tuple([
  z.string().nullable(),
  z.number().int(),
  z.number().int().min(0).max(1),
  z.number().int(),
  z.string(),
])

interface QueueRow {
  tier: number
  threadId: string
  threadRevision: number
  accountId: string
  messageId: string
  address: string | null
  ruleRevision: number
  reason: string
  at: number
  suggestFilter: number
  predictionId: string | null
  bucketPredictionId: string | null
}

export function triageQueue(db: Db, input: TriageQueueQuery): TriageQueuePage {
  let boundary: z.infer<typeof Cursor> | undefined
  const account = input.accountId ?? null
  if (input.cursor) {
    try {
      boundary = Cursor.parse(JSON.parse(input.cursor))
      if (boundary[0] !== account) throw new Error()
    } catch {
      throw new SenderError('Invalid triage queue cursor', 400)
    }
  }
  return transaction(db, () => {
    const revision = Number(
      db.prepare("SELECT seq FROM sqlite_sequence WHERE name = 'change_log'").get()?.seq ?? 0,
    )
    if (boundary && revision !== boundary[1] && !input.nextBatch)
      throw new SenderError('Triage queue changed. Start a fresh snapshot.', 409)

    // Point reads use stable indexed values before computing the representative.
    const inboxScope = input.threadId
      ? 'AND t.id = ?6'
      : input.senderAddress && account
        ? `AND t.account_id = ?1 AND t.id IN (
           SELECT m.thread_id FROM sender_index i JOIN message m ON m.id = i.message_id
           WHERE i.account_id = ?1 AND i.address = ?7 AND i.in_inbox = 1
         )`
        : ''
    const rows = db
      .prepare(`
      WITH inbox AS MATERIALIZED (
        SELECT t.id, t.account_id, t.modseq, t.last_message_at, t.bucket_confidence,
          t.bucket_input_message_id, t.bucket_reason,
          (SELECT id FROM triage_event p WHERE p.id = t.bucket_producer) AS bucket_prediction_id,
          t.filter_suggestion_message_id, t.filter_suggestion_event_id, t.bucket, ${latestInboxMessageSql} AS latest,
          (SELECT json_object('id', m.id, 'address', i.address, 'revision', coalesce(r.revision, 0),
             'status', ${senderStatusSql})
           FROM message m JOIN sender_index i ON i.message_id = m.id
           LEFT JOIN sender_rule r ON r.account_id = i.account_id AND r.address = i.address
           WHERE m.thread_id = t.id AND i.in_inbox = 1
             AND EXISTS (SELECT 1 FROM json_each(m.label_ids) WHERE value = m.account_id || ':INBOX')
           ORDER BY m.sent_at DESC, m.id DESC LIMIT 1) AS sender
        FROM thread t WHERE t.in_inbox = 1 AND (?1 IS NULL OR t.account_id = ?1)
          ${inboxScope}
      ), new_senders AS (
        SELECT t.*, row_number() OVER (
          PARTITION BY account_id, sender ->> 'address' ORDER BY last_message_at DESC, id DESC
        ) AS sender_rank
        FROM inbox t WHERE sender ->> 'status' = 'new' AND ?6 IS NULL
          AND (?7 IS NULL OR sender ->> 'address' = ?7)
          AND NOT EXISTS (SELECT 1 FROM json_each(?8) WHERE value = t.id)
      ), cards AS (
        SELECT 0 AS tier, id AS threadId, modseq AS threadRevision, account_id AS accountId,
          sender ->> 'id' AS messageId, sender ->> 'address' AS address,
          sender ->> 'revision' AS ruleRevision, 'New sender' AS reason, last_message_at AS at,
          (filter_suggestion_message_id IS latest AND latest IS NOT NULL
            AND NOT EXISTS (SELECT 1 FROM owner_handled h WHERE h.thread_id = id AND h.message_id = latest)) AS suggestFilter, filter_suggestion_event_id AS predictionId, NULL AS bucketPredictionId
        FROM new_senders WHERE sender_rank = 1
        UNION ALL
        SELECT 1, t.id, t.modseq, t.account_id, t.latest, null, 0,
          coalesce(t.bucket_reason, ''), t.last_message_at,
          (t.filter_suggestion_message_id IS t.latest), t.filter_suggestion_event_id,
          CASE WHEN t.bucket_input_message_id IS t.latest THEN t.bucket_prediction_id END
        FROM inbox t LEFT JOIN owner_handled h ON h.thread_id = t.id
        WHERE ?7 IS NULL AND (t.sender ->> 'status' IS NOT 'new' OR (t.filter_suggestion_message_id = t.latest
            AND NOT EXISTS (SELECT 1 FROM new_senders n WHERE n.id = t.id AND n.sender_rank = 1)))
          AND t.latest IS NOT NULL AND h.message_id IS NOT t.latest
          AND ((t.bucket_confidence = 'low' AND t.bucket_input_message_id = t.latest)
            OR (t.filter_suggestion_message_id = t.latest))
      )
      SELECT * FROM cards
      WHERE ?2 IS NULL OR tier > ?2 OR (tier = ?2 AND (at, threadId) < (?3, ?4))
      ORDER BY tier, at DESC, threadId DESC LIMIT ?5
    `)
      .all({
        1: account,
        2: boundary?.[2] ?? null,
        3: boundary?.[3] ?? null,
        4: boundary?.[4] ?? null,
        5: input.limit + 1,
        6: input.threadId ?? null,
        7: input.senderAddress ?? null,
        8: input.omitThreads ?? '[]',
      }) as unknown as QueueRow[]
    const page = rows.slice(0, input.limit)
    const last = page.at(-1)
    return {
      reviewLookup: true,
      revision,
      cards: page.map(
        ({
          address,
          accountId,
          threadId,
          threadRevision,
          messageId,
          ruleRevision,
          reason,
          suggestFilter,
          predictionId,
          bucketPredictionId,
        }) => ({
          id: address ? { kind: 'sender', accountId, address } : { kind: 'thread', threadId },
          accountId,
          threadId,
          threadRevision,
          messageId,
          revision: address ? ruleRevision : threadRevision,
          reason,
          ...(suggestFilter
            ? { suggestFilter: true as const, ...(predictionId ? { predictionId } : {}) }
            : {}),
          ...(bucketPredictionId && !suggestFilter ? { bucketPredictionId } : {}),
          ...(input.senderAddress && address
            ? { suggestions: senderSuggestions(db, accountId, address) }
            : {}),
        }),
      ),
      cursor:
        last && rows.length > input.limit
          ? JSON.stringify([account, revision, last.tier, last.at, last.threadId])
          : null,
    }
  })
}
