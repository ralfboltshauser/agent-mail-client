import { randomUUID } from 'node:crypto'
import { agentGrantActive, type Principal } from '../../auth/tokens.ts'
import { type Db, transaction } from '../../db/database.ts'

export function suggestSenderRule(
  db: Db,
  principal: Principal,
  mid: string,
  decision: 'accept' | 'block',
  reason: string,
): { actionId: string } | { error: string } {
  return transaction(db, () => {
    const sender = db
      .prepare(`
      SELECT i.account_id, i.address, m.thread_id FROM sender_index i JOIN message m ON m.id = i.message_id
      WHERE i.message_id = ?
    `)
      .get(mid) as { account_id: string; address: string; thread_id: string } | undefined
    const now = Date.now()
    if (
      principal.kind !== 'agent' ||
      principal.threadId ||
      !sender ||
      !agentGrantActive(db, principal.tokenId, 'read', now, sender.account_id)
    )
      return { error: 'Sender unavailable to this Agent' }
    const existing = db
      .prepare(`
      SELECT action_id FROM sender_suggestion WHERE token_id = ? AND account_id = ? AND address = ? AND decision = ?
    `)
      .get(principal.tokenId, sender.account_id, sender.address, decision)
    if (existing) return { actionId: String(existing.action_id) }
    const minute = Math.floor(now / 60_000)
    const rate = db
      .prepare(`
      UPDATE token SET mutation_count = CASE WHEN mutation_minute = ?1 THEN mutation_count + 1 ELSE 1 END,
        mutation_minute = ?1
      WHERE id = ?2 AND (mutation_minute <> ?1 OR mutation_count < 60) RETURNING id
    `)
      .get({ 1: minute, 2: principal.tokenId })
    if (!rate) return { error: 'Agent suggestion rate limit reached. Retry in the next minute.' }
    const id = randomUUID()
    db.prepare(`
      INSERT INTO agent_action (id, token_id, token_name, tool, threads, created_at, status)
      VALUES (?, ?, ?, 'suggest_sender_rule', ?, ?, 'applied')
    `).run(id, principal.tokenId, principal.name, JSON.stringify([sender.thread_id]), now)
    db.prepare('INSERT INTO sender_suggestion VALUES (?, ?, ?, ?, ?, ?, ?)').run(
      id,
      principal.tokenId,
      sender.account_id,
      sender.address,
      mid,
      decision,
      reason.replace(/amc_[A-Za-z0-9_-]{43}/g, '[redacted]'),
    )
    return { actionId: id }
  })
}
