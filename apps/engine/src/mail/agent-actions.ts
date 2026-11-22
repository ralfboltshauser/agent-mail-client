import { randomUUID } from 'node:crypto'
import {
  type AgentAction,
  type BucketInput,
  hasScope,
  type OrganiseAction,
  type VersionedDraft,
} from '@amc/protocol'
import { agentGrantActive, type Principal, withinAccount } from '../auth/tokens.ts'
import { type Db, transaction } from '../db/database.ts'
import { DraftError } from './drafts.ts'
import { MutationError, type Mutations } from './mutations.ts'
import type { MailStore } from './store.ts'

type AgentOrganise = Exclude<OrganiseAction, { kind: 'snooze' | 'trash' | 'undo' }>
const AGENT_WRITE_CAP = 60

interface ActionRow {
  id: string
  token_name: string
  tool: string
  threads: string
  created_at: number
  status: 'pending' | 'applied' | 'failed' | 'rejected'
  error: string | null
  draft_id: string | null
}

export function threadAccount(db: Db, id: string): string | undefined {
  return db.prepare('SELECT account_id FROM thread WHERE id = ?').get(id)?.account_id as
    | string
    | undefined
}

function start(db: Db, agent: Principal, tool: string, threads: string[], cost: number) {
  const id = randomUUID()
  const now = Date.now()
  const minute = Math.floor(now / 60_000)
  const accepted = db
    .prepare(`
    UPDATE token SET mutation_count = CASE WHEN mutation_minute = ?1 THEN mutation_count + ?2 ELSE ?2 END,
      mutation_minute = ?1
    WHERE id = ?3 AND kind = 'agent' AND revoked_at IS NULL AND expires_at > ?4
      AND (mutation_minute <> ?1 OR mutation_count + ?2 <= ?5)
    RETURNING id
  `)
    .get({ '1': minute, '2': cost, '3': agent.tokenId, '4': now, '5': AGENT_WRITE_CAP })
  const error = accepted
    ? null
    : `Agent grant expired, was revoked, or reached its mutation limit. If rate limited, retry in ${60 - (Math.floor(now / 1000) % 60)}s.`
  db.prepare(`
    INSERT INTO agent_action (id, token_id, token_name, tool, threads, created_at, status, error)
    VALUES (?, ?, ?, ?, ?, ?, ?, ?)
  `).run(
    id,
    agent.tokenId,
    agent.name,
    tool,
    JSON.stringify(threads.map((id) => id.replace(/amc_[A-Za-z0-9_-]{43}/g, '[redacted]'))),
    now,
    accepted ? 'pending' : 'rejected',
    error,
  )
  return { id, error }
}

export function setBucketAsAgent(
  store: MailStore,
  agent: Principal,
  input: BucketInput,
  onlyUntriaged = false,
) {
  const { db } = store
  return transaction(db, () => {
    const entry = start(db, agent, 'set_bucket', [input.threadId], 1)
    if (entry.error) return { updated: false, error: entry.error, status: 429 as const }
    const account = threadAccount(db, input.threadId)
    if (!account || !withinAccount(agent, account)) {
      const error = 'Thread is no longer available'
      db.prepare("UPDATE agent_action SET status = 'rejected', error = ? WHERE id = ?").run(
        error,
        entry.id,
      )
      return { updated: false, error, status: 404 as const }
    }
    const updated = store.setBucket(input, agent.name, onlyUntriaged)
    db.prepare('UPDATE agent_action SET status = ?, error = ? WHERE id = ?').run(
      updated ? 'applied' : 'rejected',
      updated ? null : 'Thread already has a Bucket or left the Inbox',
      entry.id,
    )
    return { updated }
  })
}

export function organizeAsAgent(
  db: Db,
  queue: Mutations,
  agent: Principal,
  tool: string,
  actions: AgentOrganise[],
) {
  return transaction(db, () => {
    const entry = start(
      db,
      agent,
      tool,
      actions.map((action) => action.threadId),
      actions.length,
    )
    if (entry.error) return entry
    try {
      for (const action of actions) {
        const account = threadAccount(db, action.threadId)
        if (!account || !agentGrantActive(db, agent.tokenId, 'organize', Date.now(), account))
          throw new MutationError('One or more Threads are unavailable to this Agent')
      }
      const mutations = queue.submit(
        agent.tokenId,
        actions.map((action) => ({ id: randomUUID(), action })),
        false,
      )
      const link = db.prepare(`
        UPDATE mutation SET agent_action_id = ?, agent_message_ids = (
          SELECT json_group_array(message_id) FROM mutation_message WHERE mutation_id = mutation.id
        ) WHERE id = ?
      `)
      for (const mutation of mutations) link.run(entry.id, mutation.id)
      return entry
    } catch (error) {
      if (!(error instanceof MutationError)) throw error
      db.prepare("UPDATE agent_action SET status = 'rejected', error = ? WHERE id = ?").run(
        error.message,
        entry.id,
      )
      return { id: entry.id, error: error.message }
    }
  })
}

export async function draftAsAgent(
  db: Db,
  agent: Principal,
  tool: string,
  threadId: string | null,
  write: () => VersionedDraft | Promise<VersionedDraft>,
) {
  const entry = transaction(db, () => start(db, agent, tool, threadId ? [threadId] : [], 1))
  if (entry.error) throw new DraftError(entry.error)
  let draft: VersionedDraft
  try {
    draft = await write()
  } catch (error) {
    db.prepare("UPDATE agent_action SET status = 'failed', error = ? WHERE id = ?").run(
      'Draft write failed',
      entry.id,
    )
    throw error
  }
  db.prepare("UPDATE agent_action SET status = 'applied', draft_id = ? WHERE id = ?").run(
    draft.id,
    entry.id,
  )
  return agentDraftResult(db, agent, draft)
}

export function agentCreatedDraft(db: Db, agent: Principal, draftId: string): boolean {
  return Boolean(
    db
      .prepare(
        "SELECT 1 FROM agent_action WHERE token_id = ? AND draft_id = ? AND tool = 'create_draft' AND status = 'applied'",
      )
      .get(agent.tokenId, draftId),
  )
}

function agentDraftResult(db: Db, agent: Principal, draft: VersionedDraft) {
  const current = db.prepare('SELECT account_id FROM draft WHERE id = ?').get(draft.id) as
    | { account_id: string }
    | undefined
  if (
    !current ||
    !withinAccount(agent, current.account_id) ||
    !withinAccount(agent, draft.accountId)
  )
    throw new DraftError('Draft unavailable to this Agent')
  return hasScope(agent.scopes, 'read')
    ? draft
    : { id: draft.id, revision: draft.revision, status: 'applied' as const }
}

function actionResult(queue: Mutations, row: ActionRow): AgentAction {
  const mutations = queue.agentResults(row.id)
  const statuses = mutations.map(({ status }) => status)
  let status: AgentAction['status'] = row.status
  if (statuses.length && !statuses.includes('pending')) {
    if (statuses.every((state) => state === 'applied')) status = 'applied'
    else if (statuses.every((state) => state === 'failed')) status = 'failed'
    else status = 'partial'
  }
  return {
    id: row.id,
    tokenName: row.token_name,
    tool: row.tool,
    threads: JSON.parse(row.threads) as string[],
    createdAt: row.created_at,
    status,
    error: row.error,
    draftId: row.draft_id,
    mutations,
  }
}

export function listAgentActions(db: Db, queue: Mutations, before?: number) {
  const rows = db
    .prepare(`
    SELECT agent_action.*, (draft.mirror_dirty = 1 AND draft.mirror_error = 1) AS draft_mirror_error
    FROM agent_action LEFT JOIN draft ON draft.id = agent_action.draft_id
    WHERE (?1 IS NULL OR seq < ?1) ORDER BY seq DESC LIMIT 51
  `)
    .all({ '1': before ?? null }) as unknown as Array<
    ActionRow & { seq: number; draft_mirror_error: number | null }
  >
  const page = rows.slice(0, 50)
  return {
    actions: page.map(
      (row): AgentAction => ({
        ...actionResult(queue, row),
        ...(row.draft_mirror_error === 1 ? { currentDraftMirrorFailed: true } : {}),
      }),
    ),
    nextBefore: rows.length > 50 ? (page.at(-1)?.seq ?? null) : null,
  }
}

export function agentAction(db: Db, queue: Mutations, tokenId: string, id: string) {
  const row = db
    .prepare('SELECT * FROM agent_action WHERE id = ? AND token_id = ?')
    .get(id, tokenId) as ActionRow | undefined
  return row ? actionResult(queue, row) : null
}
