import {
  type OutboxItem,
  type OutboxStatus,
  SEND_ACCOUNT_UNAVAILABLE,
  type SendRequest,
} from '@amc/protocol'
import { HTTPException } from 'hono/http-exception'
import type { Principal } from '../auth/tokens.ts'
import { type Db, transaction } from '../db/database.ts'
import { getSetting } from '../settings.ts'
import { newMessageId, type OutgoingMessage } from './mime.ts'

export interface FrozenMessage extends Omit<OutgoingMessage, 'date' | 'messageId'> {
  accountId: string
  draftId: string
  revision: number
  threadId: string | null
  providerDraftId: string | null
  attachments: NonNullable<OutgoingMessage['attachments']>
}

export interface Receipt {
  providerId: string
  providerThreadId: string
  detail?: string
}

type SubmitResult =
  | { kind: 'accepted'; receipt: Receipt }
  | { kind: 'retry'; afterMs?: number }
  | { kind: 'failed'; detail: string }

export interface Delivery {
  send(message: FrozenMessage, messageId: string): Promise<SubmitResult>
  find(message: FrozenMessage, messageId: string): Promise<Receipt | null>
}

interface Row {
  id: string
  snapshot: string | null
  draft_id: string
  account_id: string
  revision: number
  subject: string
  to_json: string
  released_at: number | null
  rfc_id: string
  send_at: number
  undo_until: number
  status: OutboxStatus
  next_at: number
  attempts: number
  reconciles: number
  detail: string | null
  thread_id: string | null
}

export function requireDesktopSend(principal: Principal): void {
  if (principal.kind !== 'desktop' || !principal.scopes.includes('send')) {
    throw new HTTPException(403, { message: 'Sending requires the paired desktop and send scope' })
  }
}

export class Outbox {
  #running: Promise<void> | null = null

  constructor(
    privateDb: Db,
    delivery: (accountId: string) => Delivery | null,
    publish: (message: FrozenMessage, messageId: string, receipt: Receipt) => void,
    now = Date.now,
  ) {
    this.#db = privateDb
    this.#delivery = delivery
    this.#publish = publish
    this.#now = now
  }

  readonly #db: Db
  readonly #delivery: (accountId: string) => Delivery | null
  readonly #publish: (message: FrozenMessage, messageId: string, receipt: Receipt) => void
  readonly #now: () => number

  replay(principal: Principal, input: SendRequest): OutboxItem | null {
    requireDesktopSend(principal)
    const previous = this.#row(input.id)
    if (!previous) return null
    if (previous.draft_id !== input.draftId || previous.revision !== input.revision) {
      throw new HTTPException(409, { message: 'This send request ID is already in use' })
    }
    return this.#item(previous)
  }

  enqueue(principal: Principal, input: SendRequest, freeze: () => FrozenMessage): OutboxItem {
    requireDesktopSend(principal)
    return transaction(this.#db, () => {
      const previous = this.replay(principal, input)
      if (previous) return previous
      const message = freeze()
      const active = this.#db
        .prepare(
          "SELECT id FROM outbox WHERE draft_id = ? AND status IN ('queued','dispatching','uncertain','sent') AND released_at IS NULL",
        )
        .get(message.draftId)
      if (active)
        throw new HTTPException(409, { message: 'This draft already has a send in the Outbox' })
      if (![...message.to, ...message.cc, ...message.bcc].length) {
        throw new HTTPException(400, { message: 'Add a recipient before sending' })
      }
      const now = this.#now()
      const undoUntil = now + getSetting(this.#db, 'undoSendSeconds') * 1000
      const sendAt = Math.max(input.sendAt ?? now, undoUntil)
      this.#db
        .prepare(
          `INSERT INTO outbox (id, draft_id, account_id, revision, rfc_id, snapshot, subject, to_json, send_at, undo_until, status, next_at)
         VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, 'queued', ?)`,
        )
        .run(
          input.id,
          message.draftId,
          message.accountId,
          input.revision,
          newMessageId(message.from.address),
          JSON.stringify(message),
          message.subject,
          JSON.stringify([...message.to, ...message.cc, ...message.bcc]),
          sendAt,
          undoUntil,
          sendAt,
        )
      this.#db
        .prepare('UPDATE draft SET queued_send_id = ? WHERE id = ?')
        .run(input.id, message.draftId)
      return this.#item(this.#row(input.id) as Row)
    })
  }

  cancel(principal: Principal, id: string): boolean {
    requireDesktopSend(principal)
    const changed = this.#db
      .prepare(
        "UPDATE outbox SET status = 'cancelled', snapshot = NULL WHERE id = ? AND status = 'queued'",
      )
      .run(id)
    return changed.changes > 0 || this.#row(id)?.status === 'cancelled'
  }

  resolve(principal: Principal, id: string, action: 'check' | 'reopen'): string | null {
    requireDesktopSend(principal)
    const now = this.#now()
    const query =
      action === 'check'
        ? "SET status = 'dispatching', next_at = ?1, reconciles = 0, detail = NULL"
        : "SET released_at = ?1, snapshot = NULL, detail = 'May have been sent. The owner reopened the draft.'"
    const row = this.#db
      .prepare(
        `UPDATE outbox ${query} WHERE id = ?2 AND status = 'uncertain' AND released_at IS NULL RETURNING draft_id`,
      )
      .get(now, id) as { draft_id: string } | undefined
    return row?.draft_id ?? null
  }

  list(principal: Principal): OutboxItem[] {
    requireDesktopSend(principal)
    const rows = this.#db
      .prepare(
        "SELECT id, draft_id, account_id, revision, subject, to_json, rfc_id, send_at, undo_until, status, released_at, detail, thread_id FROM outbox ORDER BY CASE WHEN status IN ('uncertain','dispatching','queued') THEN 0 ELSE 1 END, send_at DESC LIMIT 200",
      )
      .all() as unknown as Row[]
    return rows.map((row) => this.#item(row))
  }

  get(id: string): OutboxItem | null {
    const row = this.#row(id)
    return row ? this.#item(row) : null
  }

  waitForIdle(): Promise<void> | null {
    return this.#running
  }

  runDue(): Promise<void> {
    this.#running ??= this.#step().finally(() => {
      this.#running = null
    })
    return this.#running
  }

  async #step(): Promise<void> {
    const rows = this.#db
      .prepare(
        `SELECT * FROM outbox WHERE status IN ('queued','dispatching') AND next_at <= ?
       ORDER BY next_at, id LIMIT 32`,
      )
      .all(this.#now()) as unknown as Row[]
    for (const row of rows) await this.#process(row)
  }

  async #process(row: Row): Promise<void> {
    const message = this.#snapshot(row)
    const provider = this.#delivery(message.accountId)
    if (row.status === 'dispatching') {
      let receipt: Receipt | null = null
      try {
        receipt = (await provider?.find(message, row.rfc_id)) ?? null
      } catch {
        // A failed lookup provides no evidence about delivery.
      }
      if (receipt) this.#accept(row, message, receipt)
      else if (row.reconciles >= 5) {
        this.#db
          .prepare(
            "UPDATE outbox SET status = 'uncertain', detail = 'May have been sent. Check Sent before sending again.' WHERE id = ? AND status = 'dispatching'",
          )
          .run(row.id)
      } else {
        this.#db
          .prepare(
            "UPDATE outbox SET next_at = ?, reconciles = reconciles + 1 WHERE id = ? AND status = 'dispatching'",
          )
          .run(this.#now() + 15_000, row.id)
      }
      return
    }

    const claimed = transaction(this.#db, () => {
      const queued = this.#db
        .prepare('SELECT 1 FROM draft WHERE id = ? AND queued_send_id = ? AND modseq = ?')
        .get(row.draft_id, row.id, message.revision)
      if (!queued || !provider) {
        this.#db
          .prepare(
            "UPDATE outbox SET status = ?, snapshot = NULL, detail = ? WHERE id = ? AND status = 'queued' AND next_at <= ?",
          )
          .run(
            queued ? 'failed' : 'cancelled',
            queued ? SEND_ACCOUNT_UNAVAILABLE : 'The draft was removed or changed before delivery.',
            row.id,
            this.#now(),
          )
        return false
      }
      // This durable compare-and-set is the only transition that permits submission.
      return (
        this.#db
          .prepare(
            "UPDATE outbox SET status = 'dispatching', attempts = attempts + 1, next_at = ? WHERE id = ? AND status = 'queued' AND next_at <= ?",
          )
          .run(this.#now() + 15_000, row.id, this.#now()).changes > 0
      )
    })
    if (!claimed || !provider) return
    let result: SubmitResult
    try {
      result = await provider.send(message, row.rfc_id)
    } catch {
      // A restart or any ambiguous response leaves the claim in reconciliation.
      return
    }
    if (result.kind === 'accepted') this.#accept(row, message, result.receipt)
    if (result.kind === 'failed') {
      this.#db
        .prepare(
          "UPDATE outbox SET status = 'failed', snapshot = NULL, detail = ? WHERE id = ? AND status = 'dispatching'",
        )
        .run(result.detail, row.id)
    }
    if (result.kind === 'retry') {
      this.#db
        .prepare(
          "UPDATE outbox SET status = 'queued', next_at = ? WHERE id = ? AND status = 'dispatching'",
        )
        .run(
          this.#now() + Math.max(result.afterMs ?? 0, Math.min(60_000, 5_000 * (row.attempts + 1))),
          row.id,
        )
    }
  }

  #accept(row: Row, message: FrozenMessage, receipt: Receipt) {
    transaction(this.#db, () => {
      const saved = this.#db
        .prepare(
          "UPDATE outbox SET status = 'sent', snapshot = NULL, provider_id = ?, thread_id = ?, detail = ? WHERE id = ? AND status IN ('dispatching','uncertain') AND released_at IS NULL",
        )
        .run(
          receipt.providerId,
          `${message.accountId}:${receipt.providerThreadId}`,
          receipt.detail ?? null,
          row.id,
        )
      if (saved.changes) this.#publish(message, row.rfc_id, receipt)
    })
  }

  #row(id: string): Row | undefined {
    return this.#db.prepare('SELECT * FROM outbox WHERE id = ?').get(id) as unknown as
      | Row
      | undefined
  }

  #snapshot(row: Row): FrozenMessage {
    if (!row.snapshot) throw new Error('Outbox snapshot is missing')
    return JSON.parse(row.snapshot)
  }

  #item(row: Row): OutboxItem {
    return {
      id: row.id,
      draftId: row.draft_id,
      accountId: row.account_id,
      messageId: row.rfc_id,
      subject: row.subject,
      to: JSON.parse(row.to_json),
      status: row.status,
      sendAt: row.send_at,
      undoUntil: row.undo_until,
      detail: row.detail,
      threadId: row.thread_id,
      canResolve: row.status === 'uncertain' && row.released_at === null,
    }
  }
}
