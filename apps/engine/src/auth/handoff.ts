import { type Db, transaction } from '../db/database.ts'
import { DraftError, type Drafts } from '../mail/drafts.ts'
import { agentGrantActive, COMPOSER_TTL_MS, issueToken, type Principal } from './tokens.ts'

export const HANDOFF_TTL_MS = 4 * 60 * 60 * 1000

export function handoffGrant(db: Db, principal: Principal) {
  if (!principal.threadId || !principal.accountId || !principal.subject) return null
  if (
    !agentGrantActive(
      db,
      principal.tokenId,
      'read',
      Date.now(),
      principal.accountId,
      principal.threadId,
    )
  )
    return null
  return db
    .prepare(
      `SELECT h.draft_id, h.thread_id FROM handoff h
     JOIN draft d ON d.id = h.draft_id AND d.thread_id = h.thread_id
     JOIN thread t ON t.id = h.thread_id AND t.account_id = d.account_id
     WHERE h.agent_id = ? AND h.draft_id = ? AND h.thread_id = ? AND d.account_id = ?`,
    )
    .get(principal.tokenId, principal.subject, principal.threadId, principal.accountId) as
    | { draft_id: string; thread_id: string }
    | undefined
}

export async function startHandoff(db: Db, drafts: Drafts, threadId: string, id: string) {
  const recorded = db.prepare('SELECT thread_id, draft_id FROM handoff WHERE id = ?').get(id) as
    | { thread_id: string; draft_id: string }
    | undefined
  if (recorded && recorded.thread_id !== threadId)
    throw new DraftError('Handoff ID is already in use', 409)

  const accountId = db.prepare('SELECT account_id FROM thread WHERE id = ?').get(threadId)
    ?.account_id as string | undefined
  if (!accountId) throw new DraftError('Thread unavailable')
  const existing =
    recorded?.draft_id ?? drafts.list({ accountId, threadId, editable: true, limit: 1 })[0]?.id
  const draft = existing
    ? drafts.openCompose(existing)
    : await drafts.startCompose({ mode: 'reply', threadId }, async () => null)
  if (!draft || draft.accountId !== accountId) throw new DraftError('Draft unavailable', 409)

  return transaction(db, () => {
    const now = Date.now()
    db.prepare(
      `UPDATE token SET revoked_at = ? WHERE revoked_at IS NULL AND id IN (
         SELECT agent_id FROM handoff WHERE thread_id = ?
         UNION ALL SELECT composer_id FROM handoff WHERE thread_id = ?
       )`,
    ).run(now, threadId, threadId)
    const agent = issueToken(
      db,
      {
        kind: 'agent',
        name: 'T3 Handoff',
        scopes: ['read', 'draft'],
        subject: draft.id,
        accountId,
        threadId,
        expiresAt: now + HANDOFF_TTL_MS,
      },
      now,
    )
    const composer = issueToken(
      db,
      {
        kind: 'composer',
        scopes: ['draft'],
        subject: draft.id,
        name: 'Composer Link',
        expiresAt: now + COMPOSER_TTL_MS,
      },
      now,
    )
    db.prepare(
      `INSERT INTO handoff (id, draft_id, thread_id, agent_id, composer_id)
       VALUES (?, ?, ?, ?, ?)
       ON CONFLICT(id) DO UPDATE SET composer_id = excluded.composer_id, agent_id = excluded.agent_id`,
    ).run(id, draft.id, threadId, agent.id, composer.id)
    return { draftId: draft.id, composerToken: composer.secret, agentToken: agent.secret }
  })
}
