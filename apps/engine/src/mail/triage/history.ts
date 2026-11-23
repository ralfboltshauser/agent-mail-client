import { createHmac, randomBytes } from 'node:crypto'
import type {
  TriageExportInput,
  TriageHistoryEvent,
  TriageHistoryPage,
  TriageHistoryQuery,
} from '@amc/protocol'
import type { z } from 'zod'
import type { Db } from '../../db/database.ts'
import { privateReasonsEnabled, readOwnerReason } from './annotations.ts'
import { erasureStatus } from './erasure.ts'
import { bridgeStatus } from './legacy.ts'

interface Event {
  seq: number
  id: string
  account_id: string
  account_generation: number
  axis: string
  kind: string
  source: string
  label_id: string | null
  created_at: number
  action_id: string | null
  thread_id: string | null
  message_id: string | null
  arrival_key: string | null
  subject_key: string
  taxonomy_version: number
  input_revision: number | null
  features_json: string
  run_id: string | null
  target: string | null
  prediction: string | null
  retracted: number
  current_generation: number | null
  confidence: string | null
  harness_id: string | null
  model_id: string | null
  adapter_version: string | null
  prompt_version: string | null
  policy_version_id: string | null
  matched_rule_revision_id: string | null
}

const selectEvents = `
  SELECT e.*, t.id AS target, p.id AS prediction, a.mailbox_generation AS current_generation,
    EXISTS (SELECT 1 FROM triage_event u WHERE u.kind = 'undo' AND u.target_event_id = e.id) AS retracted
  FROM triage_event e
  LEFT JOIN account a ON a.id = e.account_id
  LEFT JOIN triage_event t ON t.id = e.target_event_id
  LEFT JOIN triage_event p ON p.id = e.prediction_id AND p.kind = 'prediction'
`

export function readHistory(db: Db, input: z.output<typeof TriageHistoryQuery>): TriageHistoryPage {
  const events = db
    .prepare(`
    ${selectEvents}
    WHERE (?1 IS NULL OR e.account_id = ?1) AND (?2 IS NULL OR e.seq < ?2)
    ORDER BY e.seq DESC LIMIT ?3
  `)
    .all({
      1: input.accountId ?? null,
      2: input.before ?? null,
      3: input.limit + 1,
    }) as unknown as Event[]
  const page = events.slice(0, input.limit)
  return {
    events: page.map(
      (row): TriageHistoryEvent => ({
        seq: row.seq,
        id: row.id,
        accountId: row.account_id,
        generation: row.account_generation || null,
        axis: row.axis,
        kind: row.kind,
        source: row.source,
        labelId: row.label_id,
        at: new Date(row.created_at).toISOString(),
        actionId: row.action_id,
        threadId: row.thread_id,
        targetEventId: row.target,
        predictionId: row.prediction,
        retracted: !!row.retracted,
        reasonEditable:
          row.kind === 'decision' &&
          row.account_generation === row.current_generation &&
          privateReasonsEnabled(),
        ...(input.includeReasons && row.kind === 'decision' && row.action_id
          ? readOwnerReason(db, row.action_id)
          : {}),
      }),
    ),
    before: events.length > input.limit ? (page.at(-1)?.seq ?? null) : null,
    legacy: bridgeStatus(db),
    physicalPurge: erasureStatus(db),
  }
}

function features(row: Event, ref: (kind: string, value: string | null) => string | null) {
  const value = JSON.parse(row.features_json)
  return {
    version: 1,
    sender: ref('sender', typeof value.senderHash === 'string' ? value.senderHash : null),
    senderKeyVersion: value.senderKeyVersion === 1 ? 1 : null,
    domain: typeof value.domain === 'string' ? value.domain : null,
    listId: typeof value.listId === 'string' ? value.listId : null,
    hasListUnsubscribe:
      typeof value.hasListUnsubscribe === 'boolean' ? value.hasListUnsubscribe : null,
    category: [
      'CATEGORY_PERSONAL',
      'CATEGORY_SOCIAL',
      'CATEGORY_PROMOTIONS',
      'CATEGORY_UPDATES',
      'CATEGORY_FORUMS',
    ].includes(value.category)
      ? value.category
      : null,
  }
}

export function exportHistory(db: Db, input: TriageExportInput) {
  const scope = input.accountId ?? null
  const key = randomBytes(32)
  const ref = (kind: string, value: string | null) =>
    value === null
      ? null
      : createHmac('sha256', key)
          .update(JSON.stringify([kind, value]))
          .digest('hex')
  const rows = db
    .prepare(`
    ${selectEvents} WHERE (?1 IS NULL OR e.account_id = ?1) ORDER BY e.seq
  `)
    .all({ 1: scope }) as unknown as Event[]
  const reason = input.includeReasons
    ? db.prepare('SELECT reason FROM triage_owner_reason WHERE event_id = ?')
    : undefined
  const predictions = new Map(
    rows.filter((row) => row.kind === 'prediction').map((row) => [row.id, row]),
  )
  const prediction = (row: Event) => ({
    eventId: row.id,
    labelId: row.label_id,
    confidence: row.confidence,
    producer: {
      harnessId: row.harness_id,
      modelId: row.model_id,
      adapterVersion: row.adapter_version,
      promptVersion: row.prompt_version,
    },
    policyVersionId: row.policy_version_id,
    matchedRuleRevisionId: row.matched_rule_revision_id,
    features: features(row, ref),
  })
  const lines = [
    JSON.stringify({
      kind: 'manifest',
      format: 'amc.owner-preferences',
      version: 1,
      createdAt: new Date().toISOString(),
      taxonomyVersions: [...new Set(rows.map((row) => row.taxonomy_version))].sort((a, b) => a - b),
      scope: { account: ref('account', scope), allAccounts: scope === null },
      legacy: bridgeStatus(db),
      physicalPurge: erasureStatus(db),
      reasons: reason ? 'included' : 'redacted',
    }),
  ]
  for (const row of rows) {
    const sourcePrediction = row.prediction ? predictions.get(row.prediction) : undefined
    lines.push(
      JSON.stringify({
        kind: 'event',
        eventKind: row.kind,
        id: row.id,
        sequence: row.seq,
        account: ref('account', row.account_id),
        generation: row.account_generation || null,
        axis: row.axis,
        subject: ref(
          'subject',
          JSON.stringify([row.account_id, row.account_generation, row.axis, row.subject_key]),
        ),
        thread: ref('thread', row.thread_id),
        message: ref('message', row.message_id),
        arrival: ref('arrival', row.arrival_key),
        inputRevision: row.input_revision,
        action: ref('action', row.action_id),
        run: ref('run', row.run_id),
        source: row.source,
        taxonomyVersion: row.taxonomy_version,
        labelId: row.label_id,
        createdAt: new Date(row.created_at).toISOString(),
        targetEventId: row.target,
        prediction: sourcePrediction ? prediction(sourcePrediction) : null,
        provenance: row.source === 'legacy' ? 'legacy-partial' : 'recorded',
        ...(row.kind === 'prediction'
          ? { assessment: prediction(row) }
          : { features: features(row, ref) }),
        ...(reason && (row.kind === 'decision' || row.kind === 'reason_revised')
          ? { reason: reason.get(row.id)?.reason ?? null }
          : {}),
      }),
    )
  }
  return `${lines.join('\n')}\n`
}
