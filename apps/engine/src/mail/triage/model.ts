import { randomUUID, timingSafeEqual } from 'node:crypto'
import {
  type BucketByIdInput,
  type BucketId,
  type BucketInput,
  bucketLabels,
  CustomBucketId,
  type SubmitTriagePrediction,
  TRIAGE_RECENT_WINDOW_MS,
  type TriageBucketResult,
  type TriageInputReference,
} from '@amc/protocol'
import type { z } from 'zod'
import { agentGrantActive, type Principal, withinAccount } from '../../auth/tokens.ts'
import { type Db, transaction } from '../../db/database.ts'
import { setBucketAsAgent } from '../agent-actions.ts'
import { readCatalog } from '../bucket-catalog.ts'
import { isOwnerAddress } from '../senders/index.ts'
import type { MailStore } from '../store.ts'
import {
  appendEvent,
  arrivalKey,
  generation,
  messageFeatures,
  privateDigest,
  subject,
} from './annotations.ts'
import { retrieveExamples } from './examples.ts'
import { suggestFilter } from './filtering.ts'
import { threadInput } from './input.ts'

export function hasTriageLease(db: Db, agent: Principal, scope: 'read' | 'organize') {
  const now = Date.now()
  return (
    agent.kind === 'agent' &&
    agent.accountId &&
    !agent.threadId &&
    /^triage-[0-9a-f-]{36}$/.test(agent.name) &&
    agentGrantActive(db, agent.tokenId, scope, now, agent.accountId) &&
    db
      .prepare('SELECT 1 FROM triage_lease WHERE slot = 1 AND holder = ? AND expires_at > ?')
      .get(agent.name, now) !== undefined
  )
}

export function setModelBucket(
  store: MailStore,
  agent: Principal,
  input: BucketInput,
  metadata: TriageBucketResult,
) {
  const { db } = store
  return transaction(db, () => {
    if (!hasTriageLease(db, agent, 'organize'))
      return { updated: false, error: 'A live Account-scoped triage lease is required' }
    const thread = threadInput(db, input.threadId)
    if (!thread || !withinAccount(agent, thread.account_id))
      return { updated: false, error: 'Thread is no longer available' }
    if (
      !input.bucket ||
      !thread.in_inbox ||
      !thread.input_id ||
      thread.handled_id === thread.input_id ||
      thread.modseq !== metadata.inputRevision ||
      thread.bucket !== null
    )
      return { updated: false, reason: 'The Inbox input or Bucket changed. Refresh triage.' }

    const result = setBucketAsAgent(store, agent, input, true)
    if (result.updated && input.bucket) {
      const item = subject(db, {
        axis: 'bucket',
        accountId: thread.account_id,
        threadId: input.threadId,
        mid: thread.input_id,
        revision: metadata.inputRevision,
      })
      const predictionId = item.arrival
        ? appendEvent(db, item, {
            kind: 'prediction',
            source: 'legacy',
            label: bucketLabels[input.bucket],
            runId: agent.name,
            confidence: metadata.confidence,
            dedupe: JSON.stringify([
              'legacy',
              agent.tokenId,
              thread.account_id,
              item.accountGeneration,
              input.threadId,
              item.arrival,
              metadata.inputRevision,
            ]),
            detail: {
              mode: 'live',
              projection: 'applied',
              stage: 'legacy',
              protection: 'uncertain',
            },
          })
        : null
      db.prepare(`
        UPDATE thread SET bucket_confidence = ?, bucket_input_revision = ?,
          bucket_input_message_id = ?, bucket_producer = ? WHERE id = ?
      `).run(
        metadata.confidence ?? null,
        metadata.inputRevision,
        thread.input_id,
        predictionId,
        input.threadId,
      )
    }
    return result
  })
}

// Older triage Clients only sent the untriaged condition. Preserve an explicit Clear
// on the current arrival even though its stored Bucket is null.
export function setLegacyUntriagedBucket(
  store: MailStore,
  agent: Principal,
  input: BucketInput | z.infer<typeof BucketByIdInput>,
) {
  const { db } = store
  return transaction(db, () => {
    const thread = threadInput(db, input.threadId)
    if (
      thread &&
      withinAccount(agent, thread.account_id) &&
      thread.input_id &&
      thread.input_id === thread.handled_id
    )
      return { updated: false }
    return setBucketAsAgent(store, agent, input, true)
  })
}

interface ReceiptTarget extends TriageInputReference {
  features: ReturnType<typeof messageFeatures>
  exampleIds: string[]
}

interface ContextReceipt {
  version: 1 | 2
  bucketChoices?: Partial<Record<z.infer<typeof BucketId>, number>>
  mode: 'live'
  tokenId: string
  runId: string
  expires: number
  erasureEpoch: string | null
  accountId: string
  accountGeneration: number
  inputs: ReceiptTarget[]
}

function erasureEpoch(db: Db) {
  const epoch = db.prepare('SELECT receipt_epoch FROM triage_privacy_store').get()?.receipt_epoch
  return typeof epoch === 'string' ? epoch : null
}

export function prepareContext(
  db: Db,
  agent: Principal,
  accountId: string,
  inputs: { id: string }[],
  version: 1 | 2 = 1,
) {
  const lease = db
    .prepare('SELECT expires_at FROM triage_lease WHERE slot = 1 AND holder = ?')
    .get(agent.name)
  const accountGeneration = generation(db, accountId)
  const refs = inputs.flatMap(({ id: threadId }) => {
    const state = threadInput(db, threadId)
    if (!state?.input_id || !state.in_inbox || state.account_id !== accountId) return []
    const arrival = arrivalKey(db, state.input_id)
    if (!arrival) return []
    return [
      {
        threadId,
        messageId: state.input_id,
        inputRevision: state.modseq,
        arrivalKey: arrival,
        arrival,
        features: messageFeatures(db, accountId, accountGeneration, state.input_id),
      },
    ]
  })
  const choices =
    version === 2
      ? readCatalog(db).definitions.filter(({ archived, automatic }) => !archived && automatic)
      : undefined
  const bucketChoices =
    choices &&
    Object.fromEntries(
      choices.map(({ id, classificationRevision }) => [id, classificationRevision]),
    )
  const { targets, examples } = retrieveExamples(
    db,
    accountId,
    accountGeneration,
    refs,
    choices?.map(({ id }) => id),
  )
  const runId = randomUUID()
  const context: ContextReceipt = {
    version,
    ...(bucketChoices ? { bucketChoices } : {}),
    mode: 'live',
    tokenId: agent.tokenId,
    runId,
    expires: Number(lease?.expires_at),
    erasureEpoch: erasureEpoch(db),
    accountId,
    accountGeneration,
    inputs: refs.map(({ arrival: _, ...ref }) => ({
      ...ref,
      exampleIds: targets[ref.threadId] ?? [],
    })),
  }
  const payload = Buffer.from(JSON.stringify(context)).toString('base64url')
  const receipt = `${payload}.${privateDigest(db, 'triage context', payload)}`
  return {
    decisionLogVersion: version,
    ...(choices ? { bucketChoices: choices } : {}),
    runId,
    receipt,
    examples: { targets, examples },
    refs: refs.map(({ arrival: _, features: _features, ...ref }) => ({
      ...ref,
      exampleIds: targets[ref.threadId] ?? [],
    })),
  }
}

function contextFromReceipt(db: Db, receipt: string): ContextReceipt | undefined {
  const [payload, signature, extra] = receipt.split('.')
  if (!payload || !signature || extra !== undefined || !/^[a-f0-9]{64}$/.test(signature)) return
  const expected = privateDigest(db, 'triage context', payload)
  if (!timingSafeEqual(Buffer.from(signature, 'hex'), Buffer.from(expected, 'hex'))) return
  return JSON.parse(Buffer.from(payload, 'base64url').toString())
}

const protectedContent =
  /\b(?:security|account|password|passcode|login|log[ -]?in|sign[ -]?in|verification|verify|otp|2fa|mfa|fraud|suspicious|urgent|immediately|breach|compromised|unauthori[sz]ed|recovery|authentication|billing|bill|payment|invoice|due today|deadline|overdue)\b/i

function localProtection(store: MailStore, mid: string) {
  const row = store.db
    .prepare(`
    SELECT m.subject, m.snippet, m.delivered_at, a.kind, a.cursor ->> 'imapMoves' AS imap_moves,
      m.account_id || ':IMPORTANT' IN (SELECT value FROM json_each(m.provider_label_ids)) AS important,
      r.decision, i.address, s.ready,
      (SELECT count(*) FROM message sibling
        WHERE sibling.thread_id = m.thread_id
          AND m.account_id || ':INBOX' IN (SELECT value FROM json_each(sibling.label_ids))
          AND NOT EXISTS (SELECT 1 FROM json_each(sibling.label_ids)
            WHERE value IN (m.account_id || ':SENT', m.account_id || ':DRAFT',
              m.account_id || ':SPAM', m.account_id || ':TRASH'))) AS inbox_messages
    FROM message m JOIN account a ON a.id = m.account_id
    LEFT JOIN sender_index i ON i.message_id = m.id
    LEFT JOIN sender_scan s ON s.account_id = m.account_id
    LEFT JOIN sender_rule r ON r.account_id = i.account_id AND r.address = i.address
    WHERE m.id = ?
  `)
    .get(mid)
  if (!row) return ['unavailable']
  const age = Date.now() - Number(row.delivered_at)
  const signals = [
    row.decision === 'accept' ? 'sender_accept' : null,
    row.decision === 'block' ? 'sender_block' : null,
    row.important ? 'provider_important' : null,
    row.address && isOwnerAddress(store, String(row.address)) ? 'owner_sender' : null,
    protectedContent.test(`${row.address} ${row.subject} ${row.snippet}`)
      ? 'protected_content'
      : null,
    !row.address || !row.ready || !row.delivered_at ? 'incomplete' : null,
    row.delivered_at && (age < 0 || age > TRIAGE_RECENT_WINDOW_MS) ? 'outside_recent_window' : null,
    row.inbox_messages !== 1 ? 'mixed_thread' : null,
    row.kind === 'imap' && row.imap_moves !== 1 ? 'safe_move_unavailable' : null,
  ].filter((signal) => signal !== null)
  return signals.length ? signals : ['routine']
}

export function submitPrediction(
  store: MailStore,
  agent: Principal,
  request: SubmitTriagePrediction,
) {
  const { db } = store
  return transaction(db, () => {
    if (!hasTriageLease(db, agent, 'organize'))
      return { error: 'A live Account-scoped triage lease is required' }
    const { input, outputs, producer, runId } = request
    const context = contextFromReceipt(db, request.receipt)
    const target = context?.inputs.find((ref) => ref.threadId === input.threadId)
    if (
      !context ||
      (context.version !== 1 && context.version !== 2) ||
      context.erasureEpoch !== erasureEpoch(db) ||
      !target ||
      context.runId !== runId ||
      context.expires <= Date.now() ||
      context.tokenId !== agent.tokenId ||
      context.accountId !== agent.accountId ||
      context.accountGeneration !== generation(db, context.accountId) ||
      target.messageId !== input.messageId ||
      target.arrivalKey !== input.arrivalKey ||
      target.inputRevision !== input.inputRevision
    )
      return { error: 'The triage context is invalid or expired' }

    const bucket = outputs.bucket
    const custom = bucket && CustomBucketId.safeParse(bucket.labelId).success
    const classificationRevision = bucket ? context.bucketChoices?.[bucket.labelId] : undefined
    if (custom && (context.version !== 2 || classificationRevision === undefined))
      return { error: 'The Bucket was not eligible in the captured triage context' }

    const { accountId, accountGeneration } = context
    const key = JSON.stringify(['prediction', runId, target.arrivalKey])
    const digest = privateDigest(db, 'prediction retry', request)
    const axes = ['bucket', 'filter'] as const
    const saved = db.prepare('SELECT digest FROM triage_request_fingerprint WHERE id = ?').get(key)
    if (saved) {
      if (saved.digest !== digest)
        return { error: 'A different prediction was already submitted for this input' }
      return {
        runId,
        outcomes: db
          .prepare(`
          SELECT axis, id AS eventId, detail_json ->> 'projection' AS projection
          FROM triage_event WHERE kind = 'prediction' AND run_id = ? AND arrival_key = ? ORDER BY seq
        `)
          .all(runId, target.arrivalKey),
      }
    }

    const state = threadInput(db, target.threadId)
    const stale =
      !state?.in_inbox ||
      state.modseq !== target.inputRevision ||
      state.input_id !== target.messageId ||
      arrivalKey(db, target.messageId) !== target.arrivalKey ||
      state.handled_id === target.messageId ||
      state.bucket !== null
    const local = stale ? ['stale'] : localProtection(store, target.messageId)
    const choice = custom && readCatalog(db).definitions.find(({ id }) => id === bucket?.labelId)
    const definitionStale =
      custom &&
      (!choice ||
        choice.archived ||
        !choice.automatic ||
        choice.classificationRevision !== classificationRevision)
    const bucketApplied =
      !stale &&
      bucket &&
      !definitionStale &&
      setBucketAsAgent(
        store,
        agent,
        {
          threadId: target.threadId,
          bucketId: bucket.labelId,
          reason: bucket.displayReason,
        },
        true,
      ).updated
    const record = (axis: (typeof axes)[number]) => {
      const output = outputs[axis]
      const projection =
        stale || (axis === 'bucket' && bucket && !bucketApplied)
          ? 'stale'
          : axis === 'bucket' && bucketApplied
            ? 'applied'
            : 'suggested'
      const eventId = appendEvent(
        db,
        {
          accountId,
          accountGeneration,
          axis,
          subjectKey: JSON.stringify(
            axis === 'bucket' ? [target.threadId, target.arrivalKey] : target.arrivalKey,
          ),
          threadId: target.threadId,
          messageId: target.messageId,
          arrival: target.arrivalKey,
          revision: target.inputRevision,
          features: target.features,
        },
        {
          kind: 'prediction',
          source: 'runner',
          dedupe: JSON.stringify([key, axis]),
          label: output?.labelId,
          confidence: output?.confidence,
          producer,
          runId,
          detail: {
            mode: context.mode,
            stage: 'classification',
            protection: outputs.protection,
            localProtection: local,
            projection,
            matchedRule: 'no_match',
            exampleIds: target.exampleIds,
            ...(axis === 'filter' ? { execution: 'suggestion_only' } : {}),
            ...(axis === 'bucket' && classificationRevision !== undefined
              ? { classificationRevision }
              : {}),
          },
        },
      )
      return { axis, eventId, projection }
    }
    const bucketOutcome = record('bucket')
    const filterOutcome = record('filter')
    if (!stale) {
      if (bucketApplied && bucket) {
        db.prepare(`
          UPDATE thread SET bucket_confidence = ?, bucket_input_revision = ?,
            bucket_input_message_id = ?, bucket_producer = ? WHERE id = ?
        `).run(
          bucket.confidence,
          target.inputRevision,
          target.messageId,
          bucketOutcome.eventId,
          target.threadId,
        )
      }
      if (outputs.filter?.labelId === 'filter.filtered') {
        suggestFilter(store, target.threadId, target.messageId, filterOutcome.eventId)
      } else {
        const cleared = db
          .prepare(`
          UPDATE thread SET filter_suggestion_message_id = NULL, filter_suggestion_event_id = NULL
          WHERE id = ? AND filter_suggestion_event_id IS NOT NULL
        `)
          .run(target.threadId)
        if (cleared.changes) store.recordChange('thread', target.threadId, 'upsert')
      }
    }
    db.prepare('INSERT INTO triage_request_fingerprint VALUES (?, ?)').run(key, digest)
    return { runId, outcomes: [bucketOutcome, filterOutcome] }
  })
}
