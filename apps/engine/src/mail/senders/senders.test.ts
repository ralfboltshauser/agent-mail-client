import { randomBytes, randomUUID } from 'node:crypto'
import { readdirSync } from 'node:fs'
import { join } from 'node:path'
import { SCREENED_OUT_LABEL } from '@amc/protocol'
import { Hono } from 'hono'
import { expect, it, vi } from 'vitest'
import { DbAccountState } from '../../accounts.ts'
import { authenticate, issueToken } from '../../auth/tokens.ts'
import { BlobStore } from '../../blobs.ts'
import { Sealer } from '../../crypto.ts'
import { migrate, openDatabase, schemaVersion } from '../../db/database.ts'
import { MIGRATIONS } from '../../db/migrations.ts'
import type { AppEnv } from '../../http/app.ts'
import { ownerActionRoutes, senderRoutes } from '../../http/senders.ts'
import { FakeGmail } from '../../providers/gmail/fake.ts'
import { GmailAccountSync } from '../../providers/gmail/sync.ts'
import { FakeImap } from '../../providers/imap/fake.ts'
import { SyncManager } from '../../sync/manager.ts'
import { silentLog, tempDir, testDb } from '../../test-support.ts'
import { Mutations } from '../mutations.ts'
import { MailQueries } from '../queries.ts'
import { MailStore } from '../store.ts'
import { decideSender, listSenders, senderActionStatus, undoSender } from './actions.ts'
import { normalizeSender } from './index.ts'

const mailbox = 'owner@example.com'
const sender = 'alice@example.com'

function owner(db: ReturnType<typeof testDb>) {
  const token = issueToken(db, { kind: 'cli', scopes: ['admin'], name: 'Owner' })
  const principal = authenticate(db, token.secret)
  if (!principal) throw new Error('Fixture owner missing')
  return principal
}

function request(address = sender) {
  return {
    accountId: 'a',
    address,
    expectedRevision: 0,
    clientActionId: randomUUID(),
    decision: 'block' as const,
  }
}

async function ticks(queue: Mutations, count = 2) {
  for (let i = 0; i < count; i++) await queue.tick()
}

async function gmailFixture() {
  const db = testDb()
  db.exec(
    "INSERT INTO account (id, kind, address, credentials, created_at) VALUES ('a', 'gmail', 'owner@example.com', X'00', 0)",
  )
  const store = new MailStore(db, new BlobStore(tempDir()))
  const gmail = new FakeGmail()
  gmail.add('first', {
    threadId: 'mixed',
    from: sender,
    labels: ['INBOX', 'UNREAD', 'STARRED', 'Label_work'],
  })
  gmail.add('sibling', { threadId: 'mixed', from: 'else@example.com' })
  gmail.add('archive', { threadId: 'mixed', from: sender, labels: ['UNREAD'] })
  gmail.add('spam', { from: sender, labels: ['INBOX', 'SPAM'] })
  const sync = new GmailAccountSync(gmail, store, new DbAccountState(db, 'a', [mailbox]), silentLog)
  await sync.start()
  while (await sync.backfillStep()) {}
  return { db, store, gmail, sync, principal: owner(db), queries: new MailQueries(db) }
}

it('records an IMAP block while the connection is busy with earlier work', async () => {
  const db = testDb()
  const store = new MailStore(db, new BlobStore(tempDir()))
  const sealer = new Sealer(randomBytes(32))
  const imap = new FakeImap()
  imap.capabilities.set('MOVE', true)
  const uid = imap.add('INBOX', 'Message-ID: <screen-me@example.com>')
  db.prepare(
    "INSERT INTO account (id, kind, address, credentials, created_at) VALUES ('a', 'imap', ?, ?, 0)",
  ).run(mailbox, sealer.seal({}))
  const sync = new SyncManager({
    db,
    store,
    sealer,
    log: silentLog,
    imapClient: () => imap.client,
    oauthClient: () => ({ clientId: '', clientSecret: '' }),
  })
  const queue = new Mutations(store, () => null, silentLog, {
    imap: (account, work) => sync.organiseImap(account, work),
    imapScreeningCapability: (account) => sync.imapScreeningCapability(account),
  })
  const principal = owner(db)
  const app = new Hono<AppEnv>()
  app.use('*', async (c, next) => {
    c.set('principal', principal)
    await next()
  })
  app.route('/senders', senderRoutes(store, queue))
  app.route('/owner-actions', ownerActionRoutes(store, queue))
  let release!: () => void
  const held = new Promise<void>((resolve) => {
    release = resolve
  })
  let workStarted!: () => void
  const started = new Promise<void>((resolve) => {
    workStarted = resolve
  })
  const input = request('sender@example.com')
  let earlierWork: Promise<boolean> | undefined
  let decision: Promise<Response> | undefined
  sync.start()
  try {
    await vi.waitFor(() => expect(new MailQueries(db).account('a')?.status).toBe('ready'))
    earlierWork = sync.organiseImap('a', async () => {
      workStarted()
      await held
    })
    await started
    decision = Promise.resolve(
      app.request('/senders/decisions', {
        method: 'POST',
        body: JSON.stringify(input),
      }),
    )
    await vi.waitFor(
      async () =>
        expect((await app.request(`/owner-actions/${input.clientActionId}`)).status).toBe(200),
      { timeout: 300 },
    )
    expect((await decision).status).toBe(202)
    expect(imap.folder('INBOX').messages.has(uid)).toBe(true)
    release()
    await earlierWork
    await queue.stop()
    await ticks(queue, 4)
    expect(imap.folder('INBOX').messages.has(uid)).toBe(false)
    expect(senderActionStatus(db, input.clientActionId).status).toBe('applied')
  } finally {
    release()
    await Promise.all([earlierWork, decision])
    await Promise.all([sync.stop(), queue.stop()])
    db.close()
  }
})

it('acknowledges an already accepted sender under the new action ID', async () => {
  const { db, store, principal } = await gmailFixture()
  try {
    const original = { ...request(), decision: 'accept' as const }
    expect(decideSender(store, principal, original).revision).toBe(1)
    const stale = { ...original, clientActionId: randomUUID() }
    const receipt = decideSender(store, principal, stale)
    expect(receipt).toMatchObject({
      actionId: stale.clientActionId,
      status: 'applied',
      revision: 1,
      alreadyApplied: true,
    })
    expect(decideSender(store, principal, stale)).toEqual(receipt)
    expect(senderActionStatus(db, stale.clientActionId)).toEqual(receipt)
    expect(senderActionStatus(db, original.clientActionId).status).toBe('applied')
    expect(
      db
        .prepare("SELECT count(*) AS n FROM triage_event WHERE kind = 'decision' AND action_id = ?")
        .get(stale.clientActionId),
    ).toEqual({ n: 1 })
  } finally {
    db.close()
  }
})

it('rejects a delayed opposite choice after another owner has changed the rule', async () => {
  const { db, store, principal } = await gmailFixture()
  try {
    const other = owner(db)
    const first = decideSender(store, principal, { ...request(), decision: 'accept' })
    const delayed = { ...request(), expectedRevision: 1, decision: 'block' as const }
    decideSender(store, other, { ...request(), expectedRevision: 1, decision: 'clear' })
    expect(() => decideSender(store, principal, delayed)).toThrow(
      'The sender rule changed while saving the decision. Choose Accept or Block again.',
    )
    expect(
      db.prepare('SELECT revision, decision FROM sender_rule WHERE address = ?').get(sender),
    ).toEqual({ revision: 2, decision: null })
    expect(() => senderActionStatus(db, delayed.clientActionId)).toThrow('unavailable')
    expect(
      db
        .prepare('SELECT count(*) AS n FROM triage_event WHERE action_id = ?')
        .get(delayed.clientActionId),
    ).toEqual({ n: 0 })
    expect(senderActionStatus(db, first.actionId).status).toBe('superseded')
  } finally {
    db.close()
  }
})

it('screens exact Gmail arrivals across queue restarts and honors an external return to Inbox', async () => {
  const { db, store, gmail, sync, principal, queries } = await gmailFixture()
  try {
    const input = request()
    const actionId = input.clientActionId
    expect(decideSender(store, principal, input).status).toBe('pending')
    expect(decideSender(store, principal, input).revision).toBe(1)
    expect(queries.message('a:first')?.screeningDisposition).toBe('pending')
    expect(
      decideSender(store, principal, { ...input, clientActionId: randomUUID() }),
    ).toMatchObject({ status: 'applied', alreadyApplied: true })
    const writes = vi.spyOn(gmail, 'modifyMessage')
    await ticks(new Mutations(store, () => gmail, silentLog))
    const destination = gmail.labelList.find(({ name }) => name === SCREENED_OUT_LABEL)?.id
    expect(destination).toBeTruthy()
    expect(writes).toHaveBeenCalledExactlyOnceWith(
      'first',
      [destination],
      ['INBOX'],
      expect.any(Function),
    )
    expect(await gmail.getMessageLabels('first')).toEqual([
      'UNREAD',
      'STARRED',
      'Label_work',
      destination,
    ])
    expect(await gmail.getMessageLabels('archive')).toEqual(['UNREAD'])
    expect(await gmail.getMessageLabels('spam')).toEqual(['INBOX', 'SPAM'])
    expect(queries.threadSummary('a:mixed')).toMatchObject({
      inInbox: true,
      inboxSender: { address: 'else@example.com' },
      ownerHandledMessageId: null,
    })
    gmail.setLabels('first', ['INBOX', 'UNREAD', 'STARRED', 'Label_work'])
    gmail.add('late', { threadId: 'mixed', from: sender })
    await sync.incremental()
    expect(queries.message('a:late')?.screeningDisposition).toBe('pending')
    const restarted = new Mutations(store, () => gmail, silentLog)
    await ticks(restarted)
    expect(await gmail.getMessageLabels('late')).toEqual(['UNREAD', destination])
    expect(await gmail.getMessageLabels('first')).toContain('INBOX')
    expect(undoSender(store, principal, actionId).undo?.status).toBe('pending')
    await ticks(restarted, 4)
    expect(await gmail.getMessageLabels('late')).toEqual(['UNREAD', 'INBOX'])
    expect(await gmail.getMessageLabels('sibling')).toEqual(['INBOX', 'UNREAD'])
    expect(senderActionStatus(db, actionId).undo?.status).toBe('partial')
    expect(writes.mock.calls.map(([id]) => id)).toEqual(['first', 'late', 'late'])
  } finally {
    db.close()
  }
})

it.each([false, true])(
  'keeps Gmail Inbox membership when the owner removes Screened out after preparation (initially labeled: %s)',
  async (initiallyLabeled) => {
    const { db, store, gmail, principal } = await gmailFixture()
    try {
      const base = ['INBOX', 'UNREAD', 'STARRED', 'Label_work']
      const { actionId } = decideSender(store, principal, request())
      const queue = new Mutations(store, () => gmail, silentLog)
      await queue.tick()
      const destination = gmail.labelList.find(({ name }) => name === SCREENED_OUT_LABEL)?.id
      if (!destination) throw new Error('Screened out Label was not created')
      if (initiallyLabeled) gmail.setLabels('first', [...base, destination])
      const getMessage = gmail.getMessage.bind(gmail)
      vi.spyOn(gmail, 'getMessage').mockImplementationOnce(async (id) => {
        const prepared = await getMessage(id)
        if (!initiallyLabeled) gmail.setLabels(id, [...base, destination])
        gmail.setLabels(id, base)
        return prepared
      })
      const writes = vi.spyOn(gmail, 'modifyMessage')
      await queue.tick()
      expect(writes).not.toHaveBeenCalled()
      expect(await gmail.getMessageLabels('first')).toEqual(base)
      expect(senderActionStatus(db, actionId).status).toBe('superseded')
    } finally {
      db.close()
    }
  },
)

it('does not dispatch screening for an address newly configured by the owner', async () => {
  const { db, store, gmail, principal } = await gmailFixture()
  try {
    const { actionId } = decideSender(store, principal, request())
    const queue = new Mutations(store, () => gmail, silentLog)
    await queue.tick()
    const modify = gmail.modifyMessage.bind(gmail)
    vi.spyOn(gmail, 'modifyMessage').mockImplementationOnce((...args) => {
      db.prepare(
        "INSERT INTO account (id, kind, address, credentials, created_at) VALUES ('b', 'gmail', ?, X'00', 0)",
      ).run(sender)
      return modify(...args)
    })
    await queue.tick()
    expect(await gmail.getMessageLabels('first')).toContain('INBOX')
    expect(senderActionStatus(db, actionId).status).toBe('superseded')
  } finally {
    db.close()
  }
})

it('ignores a malformed From with an unquoted mailbox outside the angle address', async () => {
  const { db, store, gmail, sync, principal } = await gmailFixture()
  try {
    gmail.add('malformed', { from: `other@example.com <${sender}>` })
    await sync.incremental()
    decideSender(store, principal, request())
    await ticks(new Mutations(store, () => gmail, silentLog))
    expect(await gmail.getMessageLabels('malformed')).toEqual(['INBOX', 'UNREAD'])
  } finally {
    db.close()
  }
})

it('inverts the acknowledged Gmail delta when Undo races a partial provider acknowledgement', async () => {
  const { db, store, gmail, principal } = await gmailFixture()
  try {
    const { actionId } = decideSender(store, principal, request())
    const queue = new Mutations(store, () => gmail, silentLog)
    await queue.tick()
    let acknowledge!: () => void
    const wait = new Promise<void>((resolve) => {
      acknowledge = resolve
    })
    let dispatched!: () => void
    const started = new Promise<void>((resolve) => {
      dispatched = resolve
    })
    const original = gmail.modifyMessage.bind(gmail)
    vi.spyOn(gmail, 'modifyMessage').mockImplementationOnce(async (id, add, _remove, guard) => {
      const state = await original(id, add, [], guard)
      dispatched()
      await wait
      return state
    })
    const task = queue.tick()
    await started
    expect(undoSender(store, principal, actionId).undo?.status).toBe('pending')
    acknowledge()
    await task
    await ticks(queue)
    expect(await gmail.getMessageLabels('first')).toEqual([
      'INBOX',
      'UNREAD',
      'STARRED',
      'Label_work',
    ])
    const status = senderActionStatus(db, actionId)
    expect(status).toMatchObject({ status: 'partial', undo: { status: 'partial' } })
  } finally {
    db.close()
  }
})

it('requires explicit adoption of a name collision and never opts into provider Spam', async () => {
  const { db, store, gmail, principal } = await gmailFixture()
  try {
    gmail.labelList.push({ id: 'Label_collision', name: SCREENED_OUT_LABEL, type: 'user' })
    const create = vi.spyOn(gmail, 'createLabel')
    const { actionId } = decideSender(store, principal, request())
    const queue = new Mutations(store, () => gmail, silentLog)
    await ticks(queue)
    expect(senderActionStatus(db, actionId)).toMatchObject({
      status: 'failed',
      error: expect.stringMatching(/adopt/),
    })
    await expect(queue.adoptScreenedDestination(principal, 'a', 'SPAM')).rejects.toThrow(/verified/)
    await queue.adoptScreenedDestination(principal, 'a', 'Label_collision')
    await queue.stop()
    await ticks(queue, 4)
    expect(await gmail.getMessageLabels('first')).toContain('Label_collision')
    expect(create).not.toHaveBeenCalled()
  } finally {
    db.close()
  }
})

it.each([
  { capability: 'MOVE', copyUid: true, missingIdentity: false, replaceFolder: false },
  { capability: 'UIDPLUS', copyUid: true, missingIdentity: false, replaceFolder: false },
  { capability: 'UIDPLUS', copyUid: true, missingIdentity: false, replaceFolder: true },
  { capability: 'UIDPLUS', copyUid: false, missingIdentity: false, replaceFolder: false },
  { capability: 'UIDPLUS', copyUid: false, missingIdentity: true, replaceFolder: false },
  { capability: '', copyUid: false, missingIdentity: false, replaceFolder: false },
])(
  'uses verified UID operations for $capability (COPYUID=$copyUid, missing identity=$missingIdentity, replaced folder=$replaceFolder)',
  async ({ capability, copyUid, missingIdentity, replaceFolder }) => {
    const db = testDb()
    const store = new MailStore(db, new BlobStore(tempDir()))
    const sealer = new Sealer(randomBytes(32))
    const imap = new FakeImap()
    if (capability) imap.capabilities.set(capability, true)
    imap.reportCopyUid = copyUid
    const uid = imap.add(
      'INBOX',
      missingIdentity ? 'Subject: No identity' : 'Message-ID: <screen-me@example.com>',
    )
    const unrelated = imap.add('INBOX', 'Message-ID: <unrelated@example.com>', 'Unrelated', [
      '\\Deleted',
    ])
    db.prepare(
      "INSERT INTO account (id, kind, address, credentials, created_at) VALUES ('a', 'imap', ?, ?, 0)",
    ).run(mailbox, sealer.seal({}))
    const sync = new SyncManager({
      db,
      store,
      sealer,
      log: silentLog,
      imapClient: () => imap.client,
      imapPollMs: 60_000,
      oauthClient: () => ({ clientId: '', clientSecret: '' }),
    })
    const queue = new Mutations(store, () => null, silentLog, {
      imap: (account, work) => sync.organiseImap(account, work),
      imapScreeningCapability: (account) => sync.imapScreeningCapability(account),
    })
    sync.start()
    try {
      await vi.waitFor(() => expect(new MailQueries(db).account('a')?.status).toBe('ready'))
      const principal = owner(db)
      const input = request('sender@example.com')
      if (!capability) {
        expect(() => decideSender(store, principal, input)).toThrow(/safe moves/)
        db.exec(
          "UPDATE account SET cursor = json_set(cursor, '$.imapMoves', json('true')) WHERE id = 'a'",
        )
        expect(() => queue.verifyScreeningCapability('a', input.clientActionId)).toThrow(
          /safe moves/,
        )
        expect(db.prepare('SELECT 1 FROM sender_rule').get()).toBeUndefined()
        return
      }
      queue.verifyScreeningCapability('a', input.clientActionId)
      const { actionId } = decideSender(store, principal, input)
      if (replaceFolder) {
        const copy = imap.messageCopy.bind(imap)
        vi.spyOn(imap, 'messageCopy').mockImplementationOnce((range, destination, options) => {
          imap.folder(destination).validity++
          return copy(range, destination, options)
        })
      }
      await ticks(queue, 4)
      if (missingIdentity || replaceFolder) {
        expect(imap.folder('INBOX').messages.has(uid)).toBe(true)
        expect(imap.folder('INBOX').messages.get(uid)?.flags.has('\\Deleted')).toBe(false)
        expect(imap.writes.some(({ command }) => command === 'UID EXPUNGE')).toBe(false)
        expect(imap.folder(SCREENED_OUT_LABEL).messages.size).toBe(1)
        expect(senderActionStatus(db, actionId)).toMatchObject({
          status: 'failed',
          error: 'Copied, original not removed',
        })
        return
      }
      expect(imap.folder('INBOX').messages.has(uid)).toBe(false)
      expect(imap.folder('INBOX').messages.has(unrelated)).toBe(true)
      expect(imap.folder(SCREENED_OUT_LABEL).messages.size).toBe(1)
      expect(imap.writes.some(({ command }) => command === 'EXPUNGE')).toBe(false)
      undoSender(store, principal, actionId)
      await ticks(queue, 4)
      expect(imap.folder(SCREENED_OUT_LABEL).messages.size).toBe(0)
      expect(imap.folder('INBOX').messages.size).toBe(2)
      expect(senderActionStatus(db, actionId).undo?.status).toBe('applied')
    } finally {
      await Promise.all([sync.stop(), queue.stop()])
      db.close()
    }
  },
)

it('upgrades a populated v20 fixture and rebuilds Account-scoped evidence without creating rules', async () => {
  const dir = tempDir()
  const db = openDatabase(join(dir, 'migration.db'))
  try {
    migrate(db, { migrations: MIGRATIONS.filter(({ version }) => version <= 20) })
    for (const account of ['a', 'b']) {
      db.prepare(
        "INSERT INTO account (id, kind, address, credentials, created_at) VALUES (?, 'gmail', ?, X'00', 0)",
      ).run(account, `${account}@example.com`)
      db.prepare(
        "INSERT INTO thread (id, account_id, provider_thread_id, in_inbox) VALUES (?, ?, 't', 1)",
      ).run(`${account}:t`, account)
      db.prepare(`INSERT INTO message (id, account_id, thread_id, provider_id, from_json, sent_at, label_ids)
        VALUES (?, ?, ?, 'in', '{"address":"ALICE@example.com","name":null}', 1, ?)`).run(
        `${account}:in`,
        account,
        `${account}:t`,
        JSON.stringify([`${account}:INBOX`]),
      )
    }
    db.exec(`INSERT INTO message (id, account_id, thread_id, provider_id, to_json, sent_at, label_ids)
      VALUES ('a:out', 'a', 'a:t', 'out', '[{"address":"alice@example.com","name":null}]', 2, '["a:SENT"]')`)
    const original = db.prepare('SELECT * FROM message ORDER BY id').all()
    const backupDir = join(dir, 'backups')
    expect(migrate(db, { backupDir })).toBe(MIGRATIONS.at(-1)?.version)
    expect(migrate(db, { backupDir })).toBe(MIGRATIONS.at(-1)?.version)
    const backups = readdirSync(backupDir)
    expect(backups).toHaveLength(1)
    const [backupName] = backups
    if (!backupName) throw new Error('Migration did not create a backup')
    const backup = openDatabase(join(backupDir, backupName))
    try {
      expect(schemaVersion(backup)).toBe(20)
      expect(backup.prepare('SELECT * FROM message ORDER BY id').all()).toEqual(original)
    } finally {
      backup.close()
    }
    expect(db.prepare('SELECT * FROM message ORDER BY id').all()).toEqual(
      original.map((row) => ({ ...row, list_id: null })),
    )
    expect(db.prepare('PRAGMA integrity_check').get()).toEqual({ integrity_check: 'ok' })
    expect(db.prepare('PRAGMA foreign_key_check').all()).toEqual([])
    const store = new MailStore(db, new BlobStore(tempDir()))
    await new Mutations(store, () => null, silentLog).tick()
    expect(
      listSenders(db, { limit: 5 }).rows.map(({ accountId, status }) => [accountId, status]),
    ).toEqual([
      ['a', 'known'],
      ['b', 'new'],
    ])
    expect(db.prepare('SELECT count(*) AS count FROM message').get()).toMatchObject({ count: 3 })
    expect(db.prepare('SELECT 1 FROM sender_rule').get()).toBeUndefined()
    expect(normalizeSender('NAME+Tag@bücher.example')).toBe('name+tag@xn--bcher-kva.example')
    expect(normalizeSender('foo@example.com/path')).toBeNull()
    expect(normalizeSender('foo@example.com, bar@example.com')).toBeNull()
  } finally {
    db.close()
  }
})
