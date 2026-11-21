import { COMPOSER_FIELD } from '@amc/composer'
import { type ComposeDraft, DRAFT_CHANGED, MIRROR_CHANGED, type OutboxItem } from '@amc/protocol'
import { simpleParser } from 'mailparser'
import { expect, it, vi } from 'vitest'
import * as Y from 'yjs'
import { upsertImapAccount } from '../accounts.ts'
import { issueToken, type Principal } from '../auth/tokens.ts'
import { BlobStore } from '../blobs.ts'
import { Sealer } from '../crypto.ts'
import { createApp } from '../http/app.ts'
import type { MailDeps } from '../http/mail.ts'
import { FakeGmail } from '../providers/gmail/fake.ts'
import { fromGmail } from '../providers/gmail/mapping.ts'
import type { GmailPart } from '../providers/gmail/types.ts'
import { FakeImap } from '../providers/imap/fake.ts'
import { draftSourceHash, ImapProvider } from '../providers/imap/provider.ts'
import { silentLog, tempDir, testConfig, testDb } from '../test-support.ts'
import { gmailDelivery, imapDraftMirror, publishSent } from './delivery.ts'
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
    mail: {
      db,
      blobs,
      store,
      queries,
      drafts,
      log: silentLog,
      sync: { gmailApi: () => gmail },
    } as unknown as MailDeps,
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

it('imports IMAP drafts without UIDPLUS and retains both versions across a replacement and UIDVALIDITY reset', async () => {
  const { db, store } = setup()
  const account = 'imap'
  db.prepare(
    "INSERT INTO account (id, kind, address, credentials, created_at) VALUES (?, 'imap', ?, X'00', 0)",
  ).run(account, 'owner@example.test')
  const fake = new FakeImap()
  const folder = fake.addFolder('Drafts', '\\Drafts')
  const provider = new ImapProvider(
    {
      imap: { host: 'localhost', port: 993, tls: 'implicit', username: 'u', password: 'fake' },
      smtp: { host: 'localhost', port: 587, tls: 'starttls', username: 'u', password: 'fake' },
      smtpSavesSent: true,
    },
    () => fake.client,
  )
  const drafts = new Drafts(db, store, () => imapDraftMirror(provider))
  const add = (text: string) =>
    fake.add('Drafts', 'Subject: Draft\r\nMessage-ID: <draft@example.test>', text, ['\\Draft'])

  const originalUid = add('Original')
  const originalHash = draftSourceHash(fixture(folder.messages.get(originalUid)).source)
  await drafts.pullImap(account, provider)
  const [original] = drafts.list()
  if (!original) throw new Error('Draft not imported')
  const displayed = drafts.compose(original.id) as ComposeDraft
  const { providerDraftId } = drafts.freeze(original.id, displayed.revision)
  if (!providerDraftId) throw new Error('Missing draft UID')
  drafts.saveCompose(original.id, {
    baseRevision: displayed.revision,
    update: edit(displayed, 'Local edit'),
  })
  fake.expunge('Drafts', originalUid)
  const replacementUid = add('Replaced elsewhere')
  await drafts.pullImap(account, provider)
  await drafts.pullImap(account, provider)
  expect(drafts.list()).toHaveLength(2)
  expect(drafts.compose(original.id)).toMatchObject({
    mirrorConflict: true,
    body: 'OriginalLocal edit',
  })
  expect(drafts.list()).toEqual(
    expect.arrayContaining([expect.objectContaining({ body: 'Replaced elsewhere' })]),
  )

  fake.expunge('Drafts', replacementUid)
  folder.validity += 1n
  folder.nextUid = originalUid
  expect(add('Different draft at reused UID')).toBe(originalUid)
  fake.capabilities.set('UIDPLUS', true)
  expect(await provider.deleteDraft(providerDraftId, originalHash)).toBe(false)
  await drafts.pullImap(account, provider)
  expect(drafts.list()).toHaveLength(3)
  expect(drafts.list()).toEqual(
    expect.arrayContaining([expect.objectContaining({ body: 'Different draft at reused UID' })]),
  )
  expect([...folder.messages.keys()]).toEqual([originalUid])
  db.close()
})

it('forwards a non-ASCII multipart message with formatting, CID placement and its file attachment', async () => {
  const { account, call, drafts, db, gmail, store } = setup()
  gmail.add('original', { threadId: 'thread', subject: 'Résumé' })
  const resource = gmail.messages.get('original')
  if (!resource?.payload) throw new Error('Missing fixture')
  const encode = (text: string): string => Buffer.from(text).toString('base64url')
  const html =
    '<p>Bonjour <strong>Élodie</strong></p><ul><li>Réponse</li></ul><p><img src="cid:image@example.test"></p>'
  const parts: GmailPart[] = [
    {
      mimeType: 'multipart/related',
      parts: [
        {
          mimeType: 'multipart/alternative',
          parts: [
            { mimeType: 'text/plain', body: { data: encode('Bonjour Élodie'), size: 15 } },
            { mimeType: 'text/html', body: { data: encode(html), size: html.length } },
          ],
        },
        {
          mimeType: 'image/png',
          filename: 'image.png',
          headers: [{ name: 'Content-ID', value: '<image@example.test>' }],
          body: { attachmentId: 'image', size: 3 },
        },
      ],
    },
    { mimeType: 'text/plain', filename: 'pièce.txt', body: { data: encode('Voilà'), size: 6 } },
  ]
  resource.payload = { ...resource.payload, mimeType: 'multipart/mixed', parts }
  store.putMessage(account, [gmail.address], fromGmail(resource))
  const fetched = vi.spyOn(gmail, 'attachment')
  const response = await call('/drafts', 'POST', { mode: 'forward', threadId: 'gmail:thread' })
  expect(response.status).toBe(201)
  const draft = (await response.json()) as ComposeDraft
  expect(draft.subject).toBe('Fwd: Résumé')
  expect(draft.attachments).toEqual([
    expect.objectContaining({ filename: 'image.png', contentId: 'image@example.test' }),
    expect.objectContaining({ filename: 'pièce.txt', contentId: null }),
  ])
  expect(fetched).toHaveBeenCalledWith('original', 'image')
  const parsed = await simpleParser(await buildMessage(drafts.freeze(draft.id, draft.revision)), {
    skipImageLinks: true,
  })
  expect(parsed.html).toContain('<blockquote>')
  expect(parsed.html).toContain('<strong>Élodie</strong>')
  expect(parsed.html).toContain('<li><p>Réponse</p></li>')
  expect(parsed.html).toContain('src="cid:image@example.test"')
  expect(parsed.attachments[0]).toMatchObject({
    cid: 'image@example.test',
    related: true,
    content: Buffer.from([1, 2, 3]),
  })
  expect(parsed.attachments[1]).toMatchObject({
    filename: 'pièce.txt',
    content: Buffer.from('Voilà'),
  })
  db.close()
})

it.each([-60_000, 60_000])(
  'uses the Engine undo window with %i ms clock skew and reports a lost cancellation race',
  async (skew) => {
    const { account, call, drafts, db, gmail, outbox, advance } = setup()
    const draft = await drafts.create({ accountId: account, to: reader, body: 'Test' }, 'owner')
    const shown = drafts.compose(draft.id) as ComposeDraft
    const response = await call('/outbox', 'POST', {
      id: 'clock-skew',
      draftId: draft.id,
      revision: shown.revision,
    })
    const item = (await response.json()) as OutboxItem
    const desktopNow = 50_000 + skew
    expect(item.undoRemainingMs).toBe(10_000)
    expect(item.undoUntil - desktopNow).not.toBe(item.undoRemainingMs)
    advance(5000)
    const { items } = (await (await call('/outbox')).json()) as { items: OutboxItem[] }
    expect(items[0]?.undoRemainingMs).toBe(5000)

    advance(5000)
    const send = vi.spyOn(gmail, 'sendMessage')
    const dispatch = outbox.runDue()
    const result = await call('/outbox/clock-skew/cancel', 'POST')
    expect(result.status).toBe(409)
    expect(await result.json()).toMatchObject({ message: 'This send can no longer be cancelled' })
    await dispatch
    expect(send).toHaveBeenCalledOnce()
    db.close()
  },
)

function fixture<T>(value: T | null | undefined): T {
  if (value == null) throw new Error('Missing IMAP draft test fixture')
  return value
}

function draftCredentials(host = 'imap.example.test') {
  return {
    imap: { host, port: 993, tls: 'implicit' as const, username: 'u', password: 'fake' },
    smtp: { host, port: 587, tls: 'starttls' as const, username: 'u', password: 'fake' },
    smtpSavesSent: true,
  }
}

function imapDraftSetup() {
  const { db, store, outbox } = setup()
  const address = 'owner-imap@example.com'
  const sealer = new Sealer(Buffer.alloc(32))
  const fake = new FakeImap()
  const folder = fake.addFolder('Drafts', '\\Drafts')
  fake.capabilities.set('UIDPLUS', true)
  const credentials = draftCredentials()
  const { id: account } = upsertImapAccount(db, store, sealer, { address, credentials })
  let provider = new ImapProvider(credentials, () => fake.client)
  const drafts = new Drafts(db, store, () => imapDraftMirror(provider))
  const relink = (replacement: FakeImap) => {
    const credentials = draftCredentials('replacement.example.test')
    expect(upsertImapAccount(db, store, sealer, { address, credentials }).id).toBe(account)
    provider = new ImapProvider(credentials, () => replacement.client)
    return provider
  }
  const addPlainDraft = (body: string) => {
    const uid = fake.add(
      'Drafts',
      'Subject: Original\r\nContent-Type: text/plain; charset=utf-8',
      body,
      ['\\Draft'],
    )
    fixture(folder.messages.get(uid)).structure = {
      type: 'text/plain',
      parameters: { charset: 'utf-8' },
    }
    return uid
  }
  return { account, addPlainDraft, db, drafts, fake, folder, outbox, provider, relink }
}

const draftOwner: Principal = {
  tokenId: 'desktop',
  name: 'Owner',
  kind: 'desktop',
  subject: null,
  scopes: ['send'],
}

it('imports a colliding draft after relink and leaves both servers alone when queueing the old draft', async () => {
  const { account, addPlainDraft, db, drafts, folder, outbox, provider, relink } = imapDraftSetup()
  const uid = addPlainDraft('Old content')
  await drafts.pullImap(account, provider)
  const original = fixture(drafts.compose(fixture(drafts.list()[0]).id))
  const replacement = new FakeImap()
  const replacementFolder = replacement.addFolder('Drafts', '\\Drafts')
  replacement.capabilities.set('UIDPLUS', true)
  expect(replacement.add('Drafts', 'Subject: Unrelated', 'New content', ['\\Draft'])).toBe(uid)
  // Matching bytes make this a test of endpoint identity independently of the source hash.
  fixture(replacementFolder.messages.get(uid)).source = Buffer.from(
    fixture(folder.messages.get(uid)).source,
  )
  await drafts.pullImap(account, relink(replacement))
  expect(drafts.list()).toHaveLength(2)
  expect(drafts.compose(original.id)?.originalDraftLeft).toBe(true)

  const item = await drafts.prepareSend(
    { id: 'relinked', draftId: original.id, revision: original.revision },
    draftOwner,
    outbox,
  )
  expect(item).toMatchObject({ status: 'queued', originalDraftLeft: true })
  expect(folder.messages.has(uid)).toBe(true)
  expect(replacementFolder.messages.has(uid)).toBe(true)
  db.close()
})

it('preserves verbatim plain text when only the subject of an imported IMAP draft changes', async () => {
  const { account, addPlainDraft, db, drafts, fake, folder, provider } = imapDraftSetup()
  const body = 'if ready:\r\n    deploy()\r\n\r\n\r\n    next()'
  const originalUid = addPlainDraft(body)
  await drafts.pullImap(account, provider)
  const original = fixture(drafts.compose(fixture(drafts.list()[0]).id))
  expect(original.body.replace(/\r\n/g, '\n')).toBe(body.replace(/\r\n/g, '\n'))

  drafts.saveCompose(original.id, {
    baseRevision: original.revision,
    update: original.update,
    fields: {
      accountId: account,
      to: original.to,
      cc: [],
      bcc: [],
      subject: 'Edited subject',
      attachmentIds: [],
    },
  })
  await drafts.mirrorPending()
  expect(folder.messages.has(originalUid)).toBe(false)
  const mirrored = await simpleParser(fixture(fake.appended[0]).raw)
  expect(mirrored.subject).toBe('Edited subject')
  expect(mirrored.text?.replace(/\r\n/g, '\n').replace(/\n$/, '')).toBe(body.replace(/\r\n/g, '\n'))
  db.close()
})

it('keeps a CID-linked PDF as a file and an inline image inline after an IMAP subject edit', async () => {
  const { account, db, drafts, fake, folder, provider } = imapDraftSetup()
  const raw = await buildMessage({
    from: { address: 'owner@example.com', name: null },
    to: reader,
    cc: [],
    bcc: [],
    subject: 'Draft',
    text: 'See report',
    html: '<p><a href="cid:report@example.test">See report</a><img src="cid:logo@example.test"></p>',
    attachments: [
      {
        filename: 'report.pdf',
        mimeType: 'application/pdf',
        content: 'UERG',
        contentId: 'report@example.test',
      },
      {
        filename: 'logo.png',
        mimeType: 'image/png',
        content: 'AQID',
        contentId: 'logo@example.test',
      },
    ],
  })
  const uid = fake.add('Drafts', 'Subject: Draft', '', ['\\Draft'])
  const original = fixture(folder.messages.get(uid))
  original.source = Buffer.from(raw)
  original.structure = {
    type: 'multipart/alternative',
    childNodes: [
      { type: 'text/plain' },
      {
        type: 'multipart/related',
        childNodes: [
          { type: 'text/html' },
          { type: 'application/pdf', id: '<report@example.test>', disposition: 'attachment' },
          { type: 'image/png', id: '<logo@example.test>', disposition: 'inline' },
        ],
      },
    ],
  }
  await drafts.pullImap(account, provider)
  await drafts.update(fixture(drafts.list()[0]).id, { subject: 'Edited subject' }, 'owner')
  await drafts.mirrorPending()
  expect(folder.messages.has(uid)).toBe(false)
  const mirrored = await simpleParser(fixture(fake.appended[0]).raw, { skipImageLinks: true })
  expect(mirrored.html).toContain('href="cid:report@example.test"')
  expect(mirrored.html).toContain('src="cid:logo@example.test"')
  expect(mirrored.attachments).toEqual([
    expect.objectContaining({
      filename: 'report.pdf',
      contentDisposition: 'attachment',
      content: Buffer.from('PDF'),
    }),
    expect.objectContaining({
      filename: 'logo.png',
      contentDisposition: 'inline',
      content: Buffer.from([1, 2, 3]),
    }),
  ])
  db.close()
})

it('keeps clean local and remote IMAP drafts separate when only Message-ID matches', async () => {
  const { account, db, drafts, fake, provider } = imapDraftSetup()
  try {
    const add = (body: string) =>
      fake.add('Drafts', 'Subject: Draft\r\nMessage-ID: <shared@example.test>', body, ['\\Draft'])
    const uid = add('Original content')
    await drafts.pullImap(account, provider)
    const original = fixture(drafts.list()[0])

    fake.expunge('Drafts', uid)
    add('Changed bytes at a new UID')
    await drafts.pullImap(account, provider)
    expect(drafts.compose(original.id)).toMatchObject({
      body: 'Original content',
      mirrorConflict: true,
    })
    expect(
      drafts
        .list()
        .map(({ body }) => body)
        .sort(),
    ).toEqual(['Changed bytes at a new UID', 'Original content'])
  } finally {
    db.close()
  }
})

it('keeps an IMAP draft when its full source changes at the same UID', async () => {
  const { account, addPlainDraft, db, drafts, fake, folder, provider } = imapDraftSetup()
  const uid = addPlainDraft('Original content')
  await drafts.pullImap(account, provider)
  const original = fixture(drafts.list()[0])
  const message = fixture(folder.messages.get(uid))
  message.source = Buffer.concat([Buffer.from('X-Provider-Header: changed\r\n'), message.source])

  await drafts.update(original.id, { subject: 'Edited subject' }, 'owner')
  await drafts.mirrorPending()
  expect(folder.messages.has(uid)).toBe(true)
  expect(fake.appended).toHaveLength(1)
  expect(drafts.compose(original.id)?.originalDraftLeft).toBe(true)
  db.close()
})

it('leaves unsupported MIME on IMAP and flags it on edit and send', async () => {
  const { account, addPlainDraft, db, drafts, fake, folder, outbox, provider } = imapDraftSetup()
  const uid = addPlainDraft('Some content')
  fixture(folder.messages.get(uid)).structure = {
    type: 'multipart/signed',
    childNodes: [{ type: 'text/plain' }],
  }
  await drafts.pullImap(account, provider)
  const original = fixture(drafts.list()[0])
  await drafts.update(original.id, { subject: 'Edited subject' }, 'owner')
  await drafts.mirrorPending()
  expect(folder.messages.has(uid)).toBe(true)
  expect(fake.appended).toHaveLength(0)
  const edited = fixture(drafts.compose(original.id))
  expect(edited.originalDraftLeft).toBe(true)
  const item = await drafts.prepareSend(
    { id: 'lossy', draftId: original.id, revision: edited.revision },
    draftOwner,
    outbox,
  )
  expect(outbox.get(item.id)).toMatchObject({ originalDraftLeft: true })
  expect(folder.messages.has(uid)).toBe(true)
  db.close()
})

it('refuses to acknowledge owner typing that targets a paragraph removed by an Agent', async () => {
  const { account, db, drafts, call } = setup()
  try {
    const draft = await drafts.create(
      { accountId: account, body: 'Keep this\nRemove this' },
      'owner',
    )
    const base = drafts.compose(draft.id)
    if (!base) throw new Error('Draft missing')
    const owner = new Y.Doc()
    Y.applyUpdate(owner, Buffer.from(base.update, 'base64'))
    const paragraph = owner.getXmlFragment(COMPOSER_FIELD).get(1) as Y.XmlElement
    const text = paragraph.get(0) as Y.XmlText
    text.insert(text.length, ' Owner typing')

    const agent = drafts.replaceComposeBody(draft.id, 'Keep this', base.revision, 'Agent')
    const response = await call(`/drafts/${draft.id}`, 'PUT', {
      baseRevision: base.revision,
      update: Buffer.from(Y.encodeStateAsUpdate(owner)).toString('base64'),
    })
    expect(response.status).toBe(409)
    expect(await response.text()).toContain('Copy your unsaved text')
    expect(text.toString()).toContain('Owner typing')
    expect(drafts.compose(draft.id)).toMatchObject({
      body: 'Keep this',
      revision: agent.revision,
    })
  } finally {
    db.close()
  }
})
