import { join } from 'node:path'
import { expect, it } from 'vitest'
import type { Principal } from '../auth/tokens.ts'
import { migrate, openDatabase } from '../db/database.ts'
import { tempDir, testDb } from '../test-support.ts'
import { type Delivery, type FrozenMessage, Outbox } from './outbox.ts'

const owner: Principal = {
  tokenId: 'desktop',
  kind: 'desktop',
  name: 'Owner',
  scopes: ['send'],
  subject: null,
}
const message: FrozenMessage = {
  accountId: 'account',
  draftId: 'draft',
  revision: 1,
  threadId: null,
  providerDraftId: null,
  from: { name: null, address: 'owner@example.test' },
  to: [{ name: null, address: 'reader@example.test' }],
  cc: [],
  bcc: [],
  subject: 'Hello',
  text: 'Hello',
  attachments: [],
}

function seedDraft(db: ReturnType<typeof testDb>) {
  db.exec(`
    INSERT INTO account (id, kind, address, credentials, created_at)
    VALUES ('account', 'gmail', 'owner@example.test', X'00', 0);
    INSERT INTO draft (id, account_id, modseq, last_author, created_at, updated_at)
    VALUES ('draft', 'account', 1, 'owner', 0, 0);
  `)
}

it('never submits an item twice under lost responses, 5xx, 429, restarts and undo races', async () => {
  const db = testDb()
  seedDraft(db)
  const seeds = Number(process.env.AMC_OUTBOX_SEEDS ?? 512)
  for (let seed = 1; seed <= seeds; seed++) {
    let state = seed
    const roll = (max: number) => {
      state = (state + 0x6d2b79f5) >>> 0
      let value = state
      value = Math.imul(value ^ (value >>> 15), value | 1)
      value ^= value + Math.imul(value ^ (value >>> 7), value | 61)
      return Math.floor((((value ^ (value >>> 14)) >>> 0) / 2 ** 32) * max)
    }
    let now = 100_000
    let delivered = 0
    let indexedAt = 0
    let attempts = 0
    const id = String(seed)
    const provider: Delivery = {
      async send() {
        attempts++
        const fault = roll(9)
        if (fault === 0 || fault === 1) return { kind: 'retry' }
        if (fault === 2) throw new Error('5xx before delivery')
        delivered++
        indexedAt = now + roll(6) * 15_000
        if (fault <= 5) throw new Error('lost response or 5xx after delivery')
        return { kind: 'accepted', receipt: { providerId: id, providerThreadId: id } }
      },
      async find() {
        if (roll(5) === 0) throw new Error('429 during reconciliation')
        return delivered && now >= indexedAt ? { providerId: id, providerThreadId: id } : null
      },
    }
    const make = () =>
      new Outbox(
        db,
        () => provider,
        () => {},
        () => now,
      )
    let outbox = make()
    const request = { id, draftId: message.draftId, revision: message.revision }
    const item = outbox.enqueue(owner, request, () => message)
    expect(
      outbox.enqueue(owner, request, () => {
        throw new Error('replayed snapshot')
      }),
    ).toEqual(item)
    now = item.sendAt + roll(3) - 1
    if (roll(2)) outbox.cancel(owner, id)
    // This interval models a process dying after the durable claim, on either side of provider acceptance.
    if (roll(5) === 0) {
      const claimed = db
        .prepare(
          "UPDATE outbox SET status = 'dispatching', next_at = ? WHERE id = ? AND status = 'queued' AND send_at <= ?",
        )
        .run(now, id, now)
      if (claimed.changes && roll(2)) await provider.send(message, item.messageId).catch(() => {})
      outbox = make()
    }
    for (let step = 0; step < 14; step++) {
      if (roll(3) === 0) outbox = make()
      const dispatch = outbox.runDue()
      if (roll(4) === 0) outbox.cancel(owner, id)
      await Promise.all([dispatch, outbox.runDue()])
      now += 30_000
    }
    const result = outbox.get(id)
    expect(delivered, `seed ${seed}, ${attempts} attempts, ${result?.status}`).toBeLessThanOrEqual(
      1,
    )
    if (result?.status === 'cancelled') expect(delivered).toBe(0)
    else if (result?.status !== 'uncertain') {
      expect(result?.status).toBe('sent')
      expect(delivered).toBe(1)
    }
    db.prepare('DELETE FROM outbox WHERE id = ?').run(id)
  }
  db.close()
}, 60_000)

it('rejects direct send and cancel dispatch for every non-desktop principal', () => {
  const db = testDb()
  const outbox = new Outbox(
    db,
    () => null,
    () => {},
  )
  for (const kind of ['agent', 'cli', 'composer', 'desktop'] as const) {
    const principal: Principal = {
      ...owner,
      kind,
      scopes: kind === 'desktop' ? ['draft'] : ['send'],
    }
    expect(() =>
      outbox.enqueue(principal, { id: 'one', draftId: 'draft', revision: 1 }, () => message),
    ).toThrow()
    expect(() => outbox.cancel(principal, 'one')).toThrow()
    expect(() => outbox.resolve(principal, 'one', 'check')).toThrow()
  }
  expect(outbox.list(owner)).toEqual([])
  db.close()
})

it('reopens an on-disk outbox with a lost provider acknowledgement without submitting again', async () => {
  const file = join(tempDir(), 'outbox.db')
  let db = openDatabase(file)
  migrate(db)
  seedDraft(db)
  let now = 100_000
  let sent: string | undefined
  const provider: Delivery = {
    async send(_message, id) {
      expect(sent).toBeUndefined()
      sent = id
      throw new Error('Response lost')
    },
    async find(_message, id) {
      return sent === id ? { providerId: 'sent-1', providerThreadId: 'thread-1' } : null
    },
  }
  const make = () =>
    new Outbox(
      db,
      () => provider,
      () => {},
      () => now,
    )
  let outbox = make()
  const request = { id: 'send', draftId: message.draftId, revision: message.revision }
  const item = outbox.enqueue(owner, request, () => message)
  now = item.sendAt
  await outbox.runDue()
  expect(outbox.cancel(owner, item.id)).toBe(false)
  db.close()

  db = openDatabase(file)
  outbox = make()
  now += 15_000
  await outbox.runDue()
  expect(sent).toBe(item.messageId)
  expect(outbox.get(item.id)?.status).toBe('sent')
  expect(
    outbox.enqueue(owner, request, () => {
      throw new Error('Cannot reuse draft')
    }).status,
  ).toBe('sent')
  db.close()
})

it('fails a due send with an unavailable Account and preserves its draft for review', async () => {
  const db = testDb()
  seedDraft(db)
  let now = 100_000
  const outbox = new Outbox(
    db,
    () => null,
    () => {},
    () => now,
  )
  const item = outbox.enqueue(
    owner,
    { id: 'offline', draftId: message.draftId, revision: 1 },
    () => message,
  )
  now = item.sendAt + 1
  await outbox.runDue()
  expect(outbox.get(item.id)).toMatchObject({
    status: 'failed',
    detail: 'The sending Account is unavailable.',
  })
  expect(db.prepare('SELECT id FROM draft WHERE id = ?').get(message.draftId)).toBeDefined()
  db.close()
})

it('dispatches newly due mail while a previous Sent lookup is still running', async () => {
  const db = testDb()
  seedDraft(db)
  db.exec(`
    INSERT INTO draft (id, account_id, modseq, last_author, created_at, updated_at)
    VALUES ('another', 'account', 1, 'owner', 0, 0)
  `)
  let now = 100_000
  let finishLookup = () => {}
  const lookup = new Promise<null>((resolve) => {
    finishLookup = () => resolve(null)
  })
  const provider: Delivery = {
    async send(frozen) {
      if (frozen.draftId === message.draftId) throw new Error('Lost response')
      return { kind: 'accepted', receipt: { providerId: 'new', providerThreadId: 'thread' } }
    },
    find: () => lookup,
  }
  const outbox = new Outbox(
    db,
    () => provider,
    () => {},
    () => now,
  )
  const first = outbox.enqueue(owner, { id: 'first', draftId: 'draft', revision: 1 }, () => message)
  now = first.sendAt
  await outbox.runDue()

  now += 15_000
  const reconciling = outbox.runDue()
  await Promise.resolve()
  const second = outbox.enqueue(owner, { id: 'second', draftId: 'another', revision: 1 }, () => ({
    ...message,
    draftId: 'another',
  }))
  now = second.sendAt
  const sending = outbox.runDue()
  try {
    await new Promise<void>((resolve) => setImmediate(resolve))
    expect(outbox.get(second.id)?.status).toBe('sent')
    expect(outbox.get(first.id)?.status).toBe('dispatching')
  } finally {
    finishLookup()
  }
  await Promise.all([reconciling, sending])
  db.close()
})
