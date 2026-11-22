import type { BucketInput, TriageBucketResult } from '@amc/protocol'
import { agentGrantActive, type Principal, withinAccount } from '../../auth/tokens.ts'
import { type Db, transaction } from '../../db/database.ts'
import { setBucketAsAgent } from '../agent-actions.ts'
import type { MailStore } from '../store.ts'
import { recordPrediction } from './annotations.ts'
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
      (!input.bucket && metadata.outcome !== 'filtered') ||
      !thread.in_inbox ||
      !thread.input_id ||
      thread.handled_id === thread.input_id ||
      thread.modseq !== metadata.inputRevision ||
      thread.bucket !== null
    )
      return { updated: false, reason: 'The Inbox input or Bucket changed. Refresh triage.' }

    if (metadata.outcome === 'filtered') {
      if (input.bucket) return { updated: false, error: 'Choose one triage outcome' }
      return suggestFilter(store, thread.account_id, input.threadId, thread.input_id, metadata)
    }
    db.prepare('UPDATE thread SET filter_suggestion_message_id = NULL WHERE id = ?').run(
      input.threadId,
    )
    const result = setBucketAsAgent(store, agent, input, true)
    if (result.updated && input.bucket) {
      recordPrediction(
        db,
        thread.account_id,
        input.threadId,
        thread.input_id,
        input.bucket,
        metadata,
      )
      db.prepare(`
        UPDATE thread SET bucket_confidence = ?, bucket_input_revision = ?,
          bucket_input_message_id = ?, bucket_producer = ? WHERE id = ?
      `).run(
        metadata.confidence ?? null,
        metadata.inputRevision,
        thread.input_id,
        agent.name,
        input.threadId,
      )
    }
    return result
  })
}

// Older triage Clients only sent the untriaged condition. Preserve an explicit Clear
// on the current arrival even though its stored Bucket is null.
export function setLegacyUntriagedBucket(store: MailStore, agent: Principal, input: BucketInput) {
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
