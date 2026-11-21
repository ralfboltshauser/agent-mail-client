import { COMPOSER_FIELD } from '@amc/composer'
import { type ComposeDraft, DRAFT_CHANGED, MIRROR_CHANGED, type OutboxItem } from '@amc/protocol'
import { simpleParser } from 'mailparser'
import { expect, it, vi } from 'vitest'
import * as Y from 'yjs'
import { issueToken } from '../auth/tokens.ts'
import { BlobStore } from '../blobs.ts'
import { createApp } from '../http/app.ts'
import type { MailDeps } from '../http/mail.ts'
import { FakeGmail } from '../providers/gmail/fake.ts'
import { silentLog, tempDir, testConfig, testDb } from '../test-support.ts'
import { gmailDelivery, publishSent } from './delivery.ts'
import { Drafts } from './drafts.ts'
import { buildMessage } from './mime.ts'
import { Outbox } from './outbox.ts'
import { MailQueries } from './queries.ts'
import { MailStore } from './store.ts'

function setup() {
  const db = testDb()
  const blobs = new BlobStore(tempDir())
  const store = new MailStore(db, blobs)
  const queries = new MailQueries(db)
  const gmail = new FakeGmail()
  const account = 'gmail'
  db.prepare(
    "INSERT INTO account (id, kind, address, credentials, created_at) VALUES (?, 'gmail', ?, X'00', 0)",
  ).run(account, gmail.address)
  const drafts = new Drafts(db, store, () => gmail)
  let now = 50_000
  const outbox = new Outbox(
    db,
    () => gmailDelivery(gmail),
    (message, id, receipt) => publishSent(store, drafts, message, id, receipt),
    () => now,
  )
  const token = issueToken(db, {
    kind: 'desktop',
    name: 'Desktop',
    scopes: ['read', 'draft', 'send'],
  }).secret
  const app = createApp({
    db,
    log: silentLog,
    config: testConfig(),
    outbox,
    mail: { db, blobs, store, queries, drafts, log: silentLog } as MailDeps,
  })
  const call = (path: string, method = 'GET', body?: unknown) =>
    app.request(`/v1/compose${path}`, {
      method,
      body: body === undefined ? undefined : JSON.stringify(body),
      headers: { authorization: `Bearer ${token}`, 'content-type': 'application/json' },
    })
  return {
    account,
    db,
    drafts,
    gmail,
    store,
    queries,
    call,
    outbox,
    advance: (ms: number) => {
      now += ms
    },
  }
}

function edit(draft: ComposeDraft, text: string) {
  const doc = new Y.Doc()
  Y.applyUpdate(doc, Buffer.from(draft.update, 'base64'))
  const state = Y.encodeStateVector(doc)
  const paragraph = doc.getXmlFragment(COMPOSER_FIELD).get(0) as Y.XmlElement
  const value = new Y.XmlText()
  value.insert(0, text, { bold: {} })
  paragraph.insert(paragraph.length, [value])
  return Buffer.from(Y.encodeStateAsUpdate(doc, state)).toString('base64')
}

it('composes a threaded Gmail reply, merges Yjs updates, schedules, and publishes once after a lost response', async () => {
  const { account, call, db, drafts, gmail, store, queries, outbox, advance } = setup()
  const sender = { address: 'sender@example.test', name: 'Sender' }
  const recipient = { address: 'other@example.test', name: null }
  const rfcId = 'message@example.test'
  store.putMessage(account, [gmail.address], {
    providerId: 'original',
    providerThreadId: 'thread',
    rfcMessageId: rfcId,
    inReplyTo: null,
    references: '<ancestor@example.test>',
    from: sender,
    to: [{ address: gmail.address, name: null }],
    cc: [recipient],
    bcc: [],
    replyTo: [],
    bodyHtml: null,
    bodyText: 'Original message',
    snippet: 'Original message',
    subject: 'Subject',
    sentAt: 1,
    size: 20,
    labels: ['INBOX'],
    attachments: [],
    listUnsubscribe: null,
  })
  drafts.setSignature(account, 'The owner')
  const created = await call('/drafts', 'POST', {
    accountId: account,
    threadId: 'gmail:thread',
    mode: 'reply-all',
  })
  expect(created.status).toBe(201)
  const draft = (await created.json()) as ComposeDraft
  expect(draft).toMatchObject({
    subject: 'Re: Subject',
    to: [sender],
    cc: [recipient],
    signature: 'The owner',
  })
  expect(draft.quote).toContain('> Original message')

  const path = `/drafts/${draft.id}`
  const upload = await call(`${path}/attachments`, 'POST', {
    filename: 'files.txt',
    mimeType: 'text/plain',
    content: Buffer.from('proof').toString('base64'),
  })
  expect(upload.status).toBe(201)
  const file = (await upload.json()) as { id: string }
  const first = await call(path, 'PUT', {
    baseRevision: draft.revision,
    update: edit(draft, 'First text'),
    fields: {
      accountId: account,
      to: draft.to,
      cc: draft.cc,
      bcc: [{ address: 'private@example.test', name: null }],
      subject: draft.subject,
      attachmentIds: [file.id],
    },
  })
  expect(first.status).toBe(200)
  const merged = await call(path, 'PUT', {
    baseRevision: draft.revision,
    update: edit(draft, 'Second text'),
  })
  expect(merged.status).toBe(200)
  const saved = (await merged.json()) as ComposeDraft
  expect(saved.body).toContain('First text')
  expect(saved.body).toContain('Second text')
  const conflict = await call(path, 'PUT', {
    baseRevision: draft.revision,
    update: edit(draft, 'Outdated'),
    fields: { accountId: account, to: [], cc: [], bcc: [], subject: 'Stale', attachmentIds: [] },
  })
  expect(conflict.status).toBe(400)

  await drafts.mirrorPending()
  expect(gmail.drafts.size).toBe(1)
  const sendMessage = gmail.sendMessage.bind(gmail)
  let sentMime: Awaited<ReturnType<typeof simpleParser>> | undefined
  const send = vi.spyOn(gmail, 'sendMessage').mockImplementation(async (input) => {
    expect(input.threadId).toBe('thread')
    sentMime = await simpleParser(input.raw)
    await sendMessage(input)
    throw new Error('Provider response lost')
  })
  const request = {
    id: 'send-operation',
    edits: { update: edit(saved, 'Sent from the latest local edit') },
    draftId: draft.id,
    revision: saved.revision,
    sendAt: 80_000,
  }
  const queued = await call('/outbox', 'POST', request)
  expect(queued.status).toBe(202)
  const item = (await queued.json()) as OutboxItem
  expect(item).toMatchObject({ sendAt: 80_000, undoUntil: 60_000, status: 'queued' })
  expect(gmail.drafts.size).toBe(0)
  expect(await (await call('/outbox', 'POST', request)).json()).toEqual(item)
  expect((await call('/outbox', 'POST', { ...request, id: 'another-operation' })).status).toBe(409)
  advance(29_999)
  await outbox.runDue()
  expect(send).not.toHaveBeenCalled()
  advance(1)
  await outbox.runDue()
  expect(outbox.get(item.id)?.status).toBe('dispatching')
  advance(15_000)
  await outbox.runDue()
  expect(outbox.get(item.id)?.status).toBe('sent')
  expect(send).toHaveBeenCalledOnce()
  expect(sentMime?.messageId).toBe(`<${item.messageId}>`)
  expect(sentMime?.inReplyTo).toBe(`<${rfcId}>`)
  expect(sentMime?.references).toEqual(['<ancestor@example.test>', `<${rfcId}>`])
  expect(sentMime?.text).toContain('Sent from the latest local edit')
  expect(sentMime?.text).toContain('The owner')
  expect(sentMime?.html).toContain('<strong>')
  expect(sentMime?.html).toContain('<blockquote')
  expect(sentMime?.attachments[0]?.content.toString()).toBe('proof')
  expect(sentMime?.bcc).toMatchObject({ value: [{ address: 'private@example.test' }] })
  expect(queries.thread('gmail:thread')?.messages.map((message) => message.rfcMessageId)).toContain(
    item.messageId,
  )
  expect(drafts.get(draft.id)).toBeNull()
  await drafts.mirrorPending()
  expect(gmail.drafts.size).toBe(0)
  db.close()
})

it('keeps both versions when Gmail changes a draft with pending AMC edits', async () => {
  const { account, db, drafts, gmail } = setup()
  const makeRaw = (text: string) =>
    buildMessage({
      from: { name: null, address: gmail.address },
      to: [{ name: null, address: 'recipient@example.test' }],
      cc: [],
      bcc: [],
      subject: 'Remote draft',
      text,
    })
  const remote = await gmail.saveDraft({ raw: await makeRaw('Remote text') })
  await drafts.pullGmail(account, gmail)
  const [local] = drafts.list()
  if (!local) throw new Error('Draft not imported')
  const doc = drafts.compose(local.id) as ComposeDraft
  expect(doc.body).toBe('Remote text')
  drafts.saveCompose(local.id, { baseRevision: doc.revision, update: edit(doc, 'Local text') })
  await gmail.saveDraft({ draftId: remote.id, raw: await makeRaw('Remote overwrite') })
  await drafts.pullGmail(account, gmail)
  expect(drafts.get(local.id)?.body).toContain('Local text')
  await drafts.mirrorPending()
  expect(gmail.drafts.size).toBe(2)
  expect((await simpleParser(gmail.drafts.get(remote.id)?.raw ?? '')).text).toContain(
    'Remote overwrite',
  )
  const copy = [...gmail.drafts].find(([id]) => id !== remote.id)
  expect((await simpleParser(copy?.[1].raw ?? '')).text).toContain('Local text')
  expect(drafts.compose(local.id)?.mirrorConflict).toBe(true)

  db.close()
})

const reader = [{ name: null, address: 'reviewed@example.test' }]

it('imports a Gmail draft and accepts deletion of the unchanged provider copy', async () => {
  const { account, db, drafts, gmail } = setup()
  const remote = await gmail.saveDraft({
    raw: await buildMessage({
      from: { name: null, address: gmail.address },
      to: reader,
      cc: [],
      bcc: [],
      subject: 'Remote draft',
      text: 'Remote text',
    }),
  })
  await drafts.pullGmail(account, gmail)
  expect(drafts.list()).toHaveLength(1)
  await gmail.deleteDraft(remote.id)
  await drafts.pullGmail(account, gmail)
  expect(drafts.list()).toEqual([])
  db.close()
})

it('rejects send with a stale displayed revision even when the click includes a body-only update', async () => {
  const { account, call, drafts, db, outbox } = setup()
  const draft = await drafts.create({ accountId: account, to: reader, body: 'Private' }, 'owner')
  const displayed = drafts.compose(draft.id) as ComposeDraft
  await drafts.update(
    draft.id,
    { to: [{ name: null, address: 'unreviewed@example.test' }] },
    'agent',
  )
  const response = await call('/outbox', 'POST', {
    id: 'stale',
    draftId: draft.id,
    revision: displayed.revision,
    edits: { update: edit(displayed, 'Local edit') },
  })
  expect(await response.json()).toMatchObject({ message: DRAFT_CHANGED })
  expect(outbox.get('stale')).toBeNull()
  expect(drafts.compose(draft.id)?.body).toBe('Private')
  db.close()
})

it('refuses queueing if the provider mirror was sent or edited in Gmail', async () => {
  const { account, call, drafts, gmail, db, outbox, advance } = setup()
  for (const change of ['sent', 'edited'] as const) {
    const draft = await drafts.create({ accountId: account, to: reader, body: change }, 'owner')
    const version = drafts.compose(draft.id) as ComposeDraft
    const entry = [...gmail.drafts.entries()][0]
    if (!entry) throw new Error('Draft was not mirrored')
    const [remoteId, remote] = entry
    if (change === 'sent') {
      await gmail.sendMessage({ raw: remote.raw })
      await gmail.deleteDraft(remoteId)
    } else {
      await gmail.saveDraft({
        draftId: remoteId,
        raw: await buildMessage({
          from: { address: gmail.address, name: null },
          to: reader,
          cc: [],
          bcc: [],
          subject: 'Changed',
          text: 'Gmail edit',
        }),
      })
    }
    const response = await call('/outbox', 'POST', {
      id: change,
      draftId: draft.id,
      revision: version.revision,
      sendAt: 100_000,
    })
    expect(await response.json()).toMatchObject({ message: MIRROR_CHANGED })
    expect(outbox.get(change)).toBeNull()
    expect(gmail.drafts.has(remoteId)).toBe(change === 'edited')
  }
  const send = vi.spyOn(gmail, 'sendMessage')
  advance(50_000)
  await outbox.runDue()
  expect(send).not.toHaveBeenCalled()
  db.close()
})

it('cancels a due send when a rollback writer deleted the queued draft', async () => {
  const { account, call, drafts, gmail, db, outbox, advance } = setup()
  const draft = await drafts.create({ accountId: account, to: reader, body: 'Test' }, 'owner')
  const version = drafts.compose(draft.id) as ComposeDraft
  const queued = await call('/outbox', 'POST', {
    id: 'rollback',
    draftId: draft.id,
    revision: version.revision,
  })
  expect(queued.status).toBe(202)
  // The pre-Compose writer deleted the draft without consulting the Outbox.
  db.prepare('DELETE FROM draft WHERE id = ?').run(draft.id)
  const send = vi.spyOn(gmail, 'sendMessage')
  advance(10_000)
  await outbox.runDue()
  expect(send).not.toHaveBeenCalled()
  expect(outbox.get('rollback')?.status).toBe('cancelled')
  db.close()
})
