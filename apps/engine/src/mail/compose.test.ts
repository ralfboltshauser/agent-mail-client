import { COMPOSER_FIELD } from '@amc/composer'
import { type ComposeDraft, DRAFT_CHANGED, MIRROR_CHANGED, type OutboxItem } from '@amc/protocol'
import { Client } from '@modelcontextprotocol/sdk/client/index.js'
import { StreamableHTTPClientTransport } from '@modelcontextprotocol/sdk/client/streamableHttp.js'
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
import { ImapLocations } from '../providers/imap/locations.ts'
import { parseMessage } from '../providers/imap/mapping.ts'
import { draftSourceHash, ImapProvider, SmtpRejection } from '../providers/imap/provider.ts'
import { silentLog, tempDir, testConfig, testDb } from '../test-support.ts'
import { gmailDelivery, imapDelivery, imapDraftMirror, publishSent } from './delivery.ts'
import { type DraftMirror, Drafts } from './drafts.ts'
import { buildMessage } from './mime.ts'
import { type Delivery, Outbox } from './outbox.ts'
import { MailQueries } from './queries.ts'
import { MailStore } from './store.ts'

function setup(imap?: { mirror: () => DraftMirror; delivery: () => Delivery }) {
  const db = testDb()
  const blobs = new BlobStore(tempDir())
  const store = new MailStore(db, blobs)
  const queries = new MailQueries(db)
  const gmail = new FakeGmail()
  const account = 'gmail'
  db.prepare(
    "INSERT INTO account (id, kind, address, credentials, created_at) VALUES (?, 'gmail', ?, X'00', 0)",
  ).run(account, gmail.address)
  const drafts = new Drafts(db, store, (id) => (id === account ? gmail : (imap?.mirror() ?? null)))
  let now = 50_000
  const outbox = new Outbox(
    db,
    (id) => (id === account ? gmailDelivery(gmail) : (imap?.delivery() ?? null)),
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
    app,
    token,
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
  expect(await (await call('/outbox', 'POST', request)).json()).toEqual({
    ...item,
    undoResponseElapsedMs: expect.any(Number),
  })
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

it('opens the exact Gmail draft in a thread without creating another draft', async () => {
  const { account, call, db, drafts, gmail, store } = setup()
  try {
    const threadId = 'shared-thread'
    const open = (messageId: string) =>
      call(`/drafts/by-message/${encodeURIComponent(`${account}:${messageId}`)}`)
    const add = async (text: string) => {
      const remote = await gmail.saveDraft({
        threadId,
        raw: await buildMessage({
          from: { name: null, address: gmail.address },
          to: reader,
          cc: [],
          bcc: [],
          subject: 'Same subject',
          text,
        }),
      })
      store.putMessage(
        account,
        [gmail.address],
        fromGmail(fixture(await gmail.getMessage(remote.message.id))),
      )
      return remote.message.id
    }
    const first = await add('First draft')
    const second = await add('Second draft')
    expect((await open(second)).status).toBe(404)

    await drafts.pullGmail(account, gmail)
    const response = await open(second)
    expect(response.status).toBe(200)
    const draft = (await response.json()) as ComposeDraft
    expect(draft.body).toBe('Second draft')
    expect(await (await open(first)).json()).toMatchObject({ body: 'First draft' })
    expect(drafts.list()).toHaveLength(2)

    const queued = await call('/outbox', 'POST', {
      id: 'send-exact-draft',
      draftId: draft.id,
      revision: draft.revision,
    })
    expect(queued.status).toBe(202)
    expect((await open(second)).status).toBe(404)
    expect(await (await open(first)).json()).toMatchObject({ body: 'First draft' })
  } finally {
    db.close()
  }
})

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

it.each(['unchanged', 'edited remotely', 'edited and synced'])(
  'discards an undone send with a mirror that was %s',
  async (state) => {
    const edited = state !== 'unchanged'
    const { account, app, call, db, drafts, gmail, token } = setup()
    const client = new Client({ name: 'AMC Desktop test', version: '1.0.0' })
    try {
      const draft = await drafts.create({ accountId: account, to: reader, body: 'Body' }, 'owner')
      const version = drafts.compose(draft.id) as ComposeDraft
      expect(
        (
          await call('/outbox', 'POST', {
            id: 'undo-discard',
            draftId: draft.id,
            revision: version.revision,
          })
        ).status,
      ).toBe(202)
      expect((await call('/outbox/undo-discard/cancel', 'POST')).ok).toBe(true)
      expect((await call(`/drafts/${draft.id}`)).ok).toBe(true)

      // The mirror may be recreated when the owner makes another edit after undoing.
      await drafts.update(draft.id, { body: 'Edited after undo' }, 'owner')
      const [mirror] = gmail.drafts.keys()
      if (!mirror) throw new Error('Draft was not mirrored')
      if (edited) {
        await gmail.saveDraft({
          draftId: mirror,
          raw: await buildMessage({
            from: { address: gmail.address, name: null },
            to: reader,
            cc: [],
            bcc: [],
            subject: 'Changed in Gmail',
            text: 'Keep this version',
          }),
        })
      }

      if (state === 'edited and synced') {
        await drafts.pullGmail(account, gmail)
        expect(drafts.compose(draft.id)?.subject).toBe('Changed in Gmail')
      }

      await client.connect(
        new StreamableHTTPClientTransport(new URL('http://localhost/mcp'), {
          requestInit: { headers: { Authorization: `Bearer ${token}` } },
          fetch: (input, init) => Promise.resolve(app.fetch(new Request(input, init))),
        }),
      )
      const result = await client.callTool({
        name: 'delete_draft',
        arguments: { draft_id: draft.id },
      })
      expect(result.isError).toBeFalsy()
      const text = Array.isArray(result.content)
        ? result.content.find((entry) => entry.type === 'text')?.text
        : undefined
      expect(JSON.parse(text ?? 'null')).toEqual({
        deleted: draft.id,
        ...(edited ? { warning: 'Draft left in Gmail' } : { providerRemoved: 'Gmail' }),
      })
      expect(await call(`/drafts/${draft.id}`)).toMatchObject({ status: 404 })
      expect(gmail.drafts.has(mirror)).toBe(edited)
    } finally {
      await client.close()
      db.close()
    }
  },
)

it('discards an imported Gmail draft in Desktop without deleting the provider copy', async () => {
  const { account, call, db, drafts, gmail } = setup()
  try {
    const remote = await gmail.saveDraft({
      raw: await buildMessage({
        from: { address: gmail.address, name: null },
        to: reader,
        cc: [],
        bcc: [],
        subject: 'Written in Gmail',
        text: 'Keep this version',
      }),
    })
    await drafts.pullGmail(account, gmail)
    const draft = fixture(drafts.list()[0])
    const response = await call(`/drafts/${draft.id}`, 'DELETE')
    expect(response.status).toBe(200)
    expect(await response.json()).toEqual({
      deleted: draft.id,
      warning: 'Draft left in Gmail',
    })
    expect(await call(`/drafts/${draft.id}`)).toMatchObject({ status: 404 })
    expect(gmail.drafts.has(remote.id)).toBe(true)
  } finally {
    db.close()
  }
})

it.each(['getDraft', 'deleteDraft'] as const)(
  'leaves the Gmail copy in place when %s fails during discard',
  async (method) => {
    const { account, call, db, drafts, gmail } = setup()
    try {
      const draft = await drafts.create({ accountId: account, body: 'Test draft' }, 'owner')
      const [mirror] = gmail.drafts.keys()
      if (!mirror) throw new Error('Missing draft mirror')
      const read = vi.spyOn(gmail, 'getDraft')
      const remove = vi.spyOn(gmail, 'deleteDraft')
      const failingCall = method === 'getDraft' ? read : remove
      failingCall.mockRejectedValueOnce(new Error('Offline'))
      const path = `/drafts/${draft.id}`
      expect(await (await call(path, 'DELETE')).json()).toEqual({
        deleted: draft.id,
        warning: 'Draft left in Gmail',
      })
      expect(await (await call(path, 'DELETE')).json()).toEqual({ absent: draft.id })

      await drafts.mirrorPending()
      expect(read).toHaveBeenCalledOnce()
      expect(remove).toHaveBeenCalledTimes(method === 'getDraft' ? 0 : 1)
      expect(gmail.drafts.has(mirror)).toBe(true)
      await drafts.pullGmail(account, gmail)
      expect(drafts.list()).toHaveLength(1)
    } finally {
      db.close()
    }
  },
)

it('clears a legacy Gmail discard retry without touching the provider copy', async () => {
  const { account, db, drafts, gmail } = setup()
  try {
    const draft = await drafts.create({ accountId: account, body: 'Test draft' }, 'owner')
    db.prepare(`INSERT INTO draft_mirror_removal (account_id, provider_draft_id, mirror_hash, draft_id)
      SELECT account_id, provider_draft_id, mirror_written_hash, id FROM draft WHERE id = ?`).run(
      draft.id,
    )
    db.prepare('DELETE FROM draft WHERE id = ?').run(draft.id)
    const read = vi.spyOn(gmail, 'getDraft')
    const remove = vi.spyOn(gmail, 'deleteDraft')

    await drafts.mirrorPending()
    expect(read).not.toHaveBeenCalled()
    expect(remove).not.toHaveBeenCalled()
    expect(db.prepare('SELECT * FROM draft_mirror_removal').all()).toEqual([])
    expect(gmail.drafts.size).toBe(1)
  } finally {
    db.close()
  }
})

it('keeps a newer draft revision when the owner confirms discard of a stale selection', async () => {
  const { account, call, drafts, db, gmail } = setup()
  try {
    const draft = await drafts.create({ accountId: account, body: 'Original' }, 'owner')
    const shown = drafts.compose(draft.id) as ComposeDraft
    const changed = drafts.saveCompose(draft.id, {
      baseRevision: shown.revision,
      update: edit(shown, 'Edited elsewhere'),
    })
    const remove = vi.spyOn(gmail, 'deleteDraft')
    const response = await call(`/drafts/${draft.id}/discard`, 'POST', {
      revision: shown.revision,
    })
    expect(response.status).toBe(409)
    expect(await response.json()).toMatchObject({
      message: 'Draft changed. Review it before discarding.',
    })
    expect(drafts.get(draft.id)?.revision).toBe(changed.revision)
    expect(remove).not.toHaveBeenCalled()
  } finally {
    db.close()
  }
})

it('reports a draft that disappeared after delivery', async () => {
  const { account, call, db, drafts, outbox, advance } = setup()
  try {
    const draft = await drafts.create({ accountId: account, to: reader, body: 'Body' }, 'owner')
    const response = await call('/outbox', 'POST', {
      id: 'sent-discard',
      draftId: draft.id,
      revision: draft.revision,
    })
    expect(response.status).toBe(202)
    advance(60_000)
    await outbox.runDue()
    expect(outbox.get('sent-discard')?.status).toBe('sent')
    expect(
      await (
        await call(`/drafts/${draft.id}/discard`, 'POST', { revision: draft.revision })
      ).json(),
    ).toEqual({ absent: draft.id })
  } finally {
    db.close()
  }
})

it('keeps an active queued send and its draft when Desktop tries to discard', async () => {
  const { account, call, db, drafts, outbox } = setup()
  try {
    const draft = await drafts.create({ accountId: account, to: reader, body: 'Body' }, 'owner')
    const response = await call('/outbox', 'POST', {
      id: 'queued-discard',
      draftId: draft.id,
      revision: draft.revision,
    })
    expect(response.status).toBe(202)
    expect((await call(`/drafts/${draft.id}`, 'DELETE')).status).toBe(400)
    expect(drafts.get(draft.id)).not.toBeNull()
    expect(outbox.get('queued-discard')?.status).toBe('queued')
  } finally {
    db.close()
  }
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

it.each(['before discard', 'after STORE', 'still a draft'])(
  'verifies the IMAP Draft flag when it was removed %s',
  async (state) => {
    const db = testDb()
    try {
      const account = 'imap'
      db.prepare(
        "INSERT INTO account (id, kind, address, credentials, created_at) VALUES (?, 'imap', ?, X'00', 0)",
      ).run(account, 'owner@example.test')
      const fake = new FakeImap()
      fake.capabilities.set('UIDPLUS', true)
      const folder = fake.addFolder('Drafts', '\\Drafts')
      const regular = fake.add('Drafts', 'Subject: Regular message')
      const provider = new ImapProvider(
        {
          imap: { host: 'localhost', port: 993, tls: 'implicit', username: 'u', password: 'fake' },
          smtp: { host: 'localhost', port: 587, tls: 'starttls', username: 'u', password: 'fake' },
          smtpSavesSent: true,
        },
        () => fake.client,
      )
      const drafts = new Drafts(db, new MailStore(db, new BlobStore(tempDir())), () =>
        imapDraftMirror(provider),
      )
      await drafts.pullImap(account, provider)
      expect(drafts.list()).toEqual([])

      const draft = await drafts.create({ accountId: account, body: 'Written in AMC' }, 'owner')
      const [uid] = [...folder.messages.keys()].filter((key) => key !== regular)
      if (uid === undefined) throw new Error('Draft was not mirrored')
      if (state === 'before discard') fake.flag('Drafts', uid, ['\\Seen'])
      if (state === 'after STORE') {
        const flagsAdd = fake.messageFlagsAdd.bind(fake)
        vi.spyOn(fake, 'messageFlagsAdd').mockImplementationOnce(async (...args) => {
          const added = await flagsAdd(...args)
          fake.flag('Drafts', uid, ['\\Seen', '\\Deleted'])
          return added
        })
      }
      const expunge = vi.spyOn(fake, 'uidExpunge')
      const result = await drafts.delete(draft.id)
      expect(drafts.get(draft.id)).toBeNull()
      if (state === 'still a draft') {
        expect(result).toEqual({ deleted: draft.id, providerRemoved: 'IMAP' })
        expect(expunge).toHaveBeenCalledExactlyOnceWith(uid)
        expect(folder.messages.has(uid)).toBe(false)
      } else {
        expect(result).toEqual({
          deleted: draft.id,
          warning: 'A copy in IMAP was left untouched.',
        })
        expect(expunge).not.toHaveBeenCalled()
        expect(folder.messages.get(uid)?.flags).toEqual(new Set(['\\Seen']))
      }
      expect(folder.messages.has(regular)).toBe(true)
    } finally {
      db.close()
    }
  },
)

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
    let monotonicOffset = 0
    const performanceNow = performance.now.bind(performance)
    const engineClock = vi
      .spyOn(performance, 'now')
      .mockImplementation(() => performanceNow() + monotonicOffset)
    const getDraft = gmail.getDraft.bind(gmail)
    vi.spyOn(gmail, 'getDraft').mockImplementationOnce((id) => {
      monotonicOffset = 12_000
      return getDraft(id)
    })
    const response = await Promise.resolve(
      call('/outbox', 'POST', {
        id: 'clock-skew',
        draftId: draft.id,
        revision: shown.revision,
      }),
    ).finally(() => engineClock.mockRestore())
    const item = (await response.json()) as OutboxItem
    const desktopNow = 50_000 + skew
    expect(item.undoRemainingMs).toBe(10_000)
    expect(item.undoResponseElapsedMs).toBeGreaterThanOrEqual(12_000)
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
  const address = 'owner-imap@example.com'
  const sealer = new Sealer(Buffer.alloc(32))
  const fake = new FakeImap()
  const folder = fake.addFolder('Drafts', '\\Drafts')
  fake.capabilities.set('UIDPLUS', true)
  const credentials = draftCredentials()
  let provider = new ImapProvider(credentials, () => fake.client)
  const { db, store, queries, drafts, outbox, call, advance } = setup({
    mirror: () => imapDraftMirror(provider),
    delivery: () => imapDelivery(provider),
  })
  const { id: account } = upsertImapAccount(db, store, sealer, { address, credentials })
  const relink = (replacement: FakeImap) => {
    const credentials = draftCredentials('replacement.example.test')
    expect(upsertImapAccount(db, store, sealer, { address, credentials }).id).toBe(account)
    provider = new ImapProvider(credentials, () => replacement.client)
    return provider
  }
  const addPlainDraft = (body: string) => {
    const uid = fake.add(
      'Drafts',
      'Subject: Original\r\nTo: reviewed@example.test\r\nContent-Type: text/plain; charset=utf-8',
      body,
      ['\\Draft'],
    )
    fixture(folder.messages.get(uid)).structure = {
      type: 'text/plain',
      parameters: { charset: 'utf-8' },
    }
    return uid
  }
  return {
    account,
    addPlainDraft,
    store,
    queries,
    db,
    drafts,
    fake,
    folder,
    outbox,
    provider,
    relink,
    call,
    advance,
  }
}

it('opens a verified IMAP draft and rejects ambiguous locations and pre-relink cards', async () => {
  const { account, addPlainDraft, call, db, drafts, folder, provider, queries, store, relink } =
    imapDraftSetup()
  try {
    const uid = addPlainDraft('IMAP draft')
    const location = fixture((await provider.listDrafts())[0])
    const hash = store.blobs.put(fixture(folder.messages.get(uid)).source)
    const item = { uid, seq: 1 }
    const incoming = await parseMessage(
      location.folder,
      location.uidValidity,
      item,
      store.blobs,
      hash,
    )
    const locations = new ImapLocations(store, account, 'owner-imap@example.com')
    locations.put(location.folder, location.uidValidity, item, incoming, hash)
    await drafts.pullImap(account, provider)

    const messageId = `${account}:${incoming.providerId}`
    const revision = fixture(queries.message(messageId)?.imapDraftRevision)
    const open = (observed = revision) =>
      call(
        `/drafts/by-message/${encodeURIComponent(messageId)}?${new URLSearchParams({ imapRevision: observed })}`,
      )
    expect(await (await open()).json()).toMatchObject({
      body: 'IMAP draft',
      id: drafts.list()[0]?.id,
    })
    locations.put(location.folder, location.uidValidity, { ...item, uid: uid + 1 }, incoming, hash)
    expect((await open()).status).toBe(404)
    locations.remove(location.folder.path, location.uidValidity, uid + 1)
    db.prepare('UPDATE imap_location SET verified = 0 WHERE message_id = ?').run(messageId)
    expect((await open()).status).toBe(404)
    db.prepare('UPDATE imap_location SET verified = 1 WHERE message_id = ?').run(messageId)
    const replacement = new FakeImap()
    const newFolder = replacement.addFolder('Drafts', '\\Drafts')
    const newProvider = relink(replacement)
    expect((await open()).status).toBe(404)
    const newUid = replacement.add('Drafts', 'Subject: Replacement', 'Different draft', ['\\Draft'])
    const newLocation = fixture((await newProvider.listDrafts())[0])
    expect(newUid).toBe(uid)
    expect(newLocation.uidValidity).toBe(location.uidValidity)
    const newHash = store.blobs.put(fixture(newFolder.messages.get(newUid)).source)
    const newMessage = await parseMessage(
      newLocation.folder,
      newLocation.uidValidity,
      item,
      store.blobs,
      newHash,
    )
    expect(newMessage.providerId).toBe(incoming.providerId)
    locations.put(newLocation.folder, newLocation.uidValidity, item, newMessage, newHash)
    await drafts.pullImap(account, newProvider)
    expect((await open()).status).toBe(404)
    const replacementRevision = fixture(queries.message(messageId)?.imapDraftRevision)
    const replacementDraft = (await (await open(replacementRevision)).json()) as ComposeDraft
    expect(replacementDraft.body).toBe('Different draft')

    const duplicateUid = replacement.add('Drafts', 'Subject: Replacement', 'Different draft', [
      '\\Draft',
    ])
    locations.put(
      newLocation.folder,
      newLocation.uidValidity,
      { ...item, uid: duplicateUid },
      newMessage,
      newHash,
    )
    await drafts.pullImap(account, newProvider)
    expect((await open(replacementRevision)).status).toBe(404)
    replacement.expunge('Drafts', newUid)
    locations.remove(newLocation.folder.path, newLocation.uidValidity, newUid)
    expect((await open(replacementRevision)).status).toBe(404)
    const duplicateRevision = fixture(queries.message(messageId)?.imapDraftRevision)
    const survivingDraft = (await (await open(duplicateRevision)).json()) as ComposeDraft
    expect(survivingDraft.body).toBe('Different draft')
    expect(survivingDraft.id).not.toBe(replacementDraft.id)
  } finally {
    db.close()
  }
})

const draftOwner: Principal = {
  tokenId: 'desktop',
  name: 'Owner',
  kind: 'desktop',
  subject: null,
  scopes: ['send'],
}

it.each([
  'unchanged',
  'changed bytes',
  'new UIDVALIDITY',
  'missing Draft flag',
  'no UIDPLUS',
  'non-desktop discard',
])('verifies an imported IMAP draft at discard with %s', async (scenario) => {
  const { account, addPlainDraft, call, db, drafts, fake, folder, provider } = imapDraftSetup()
  try {
    const uid = addPlainDraft('Imported content')
    const other = fake.add('Drafts', 'Subject: Unrelated deleted message', '', ['\\Deleted'])
    await drafts.pullImap(account, provider)
    const draft = fixture(drafts.list()[0])
    await drafts.update(draft.id, { subject: 'Edited in AMC' }, 'owner')
    await drafts.mirrorPending()
    const expunge = vi.spyOn(fake, 'uidExpunge')
    const source = fixture(folder.messages.get(uid))
    if (scenario === 'changed bytes')
      source.source = Buffer.concat([Buffer.from('X-Provider-Header: changed\r\n'), source.source])
    if (scenario === 'new UIDVALIDITY') folder.validity += 1n
    if (scenario === 'missing Draft flag') fake.flag('Drafts', uid, ['\\Seen'])
    if (scenario === 'no UIDPLUS') fake.capabilities.delete('UIDPLUS')

    const path = `/drafts/${draft.id}`
    const result =
      scenario === 'non-desktop discard'
        ? await drafts.delete(draft.id)
        : await (scenario === 'revision-checked discard'
            ? await call(`${path}/discard`, 'POST', {
                revision: fixture(drafts.get(draft.id)).revision,
              })
            : await call(path, 'DELETE')
          ).json()
    expect(drafts.get(draft.id)).toBeNull()
    const removed = scenario === 'unchanged' || scenario === 'revision-checked discard'
    if (removed) {
      expect(result).toEqual({ deleted: draft.id, providerRemoved: 'IMAP' })
      expect(expunge).toHaveBeenCalledExactlyOnceWith(uid)
      await drafts.pullImap(account, provider)
      expect(drafts.list()).toHaveLength(0)
    } else {
      expect(result).toMatchObject({ deleted: draft.id, warning: expect.any(String) })
      expect(expunge).not.toHaveBeenCalled()
      expect(folder.messages.get(uid)?.flags.has('\\Deleted')).toBe(false)
    }
    expect(folder.messages.has(uid)).toBe(!removed)
    expect(folder.messages.has(other)).toBe(true)
  } finally {
    db.close()
  }
})

it.each([
  'accepted',
  'cancelled',
  'rejected',
  'partially accepted',
  'reconciled',
  'changed on server',
])(
  'only removes an unchanged imported IMAP draft after confirmed owner send (%s)',
  async (scenario) => {
    const { account, addPlainDraft, advance, call, db, drafts, fake, folder, provider, outbox } =
      imapDraftSetup()
    try {
      const uid = addPlainDraft('Imported content')
      if (scenario === 'partially accepted') {
        const source = fixture(folder.messages.get(uid))
        source.source = Buffer.concat([Buffer.from('Cc: rejected@example.test\r\n'), source.source])
      }
      await drafts.pullImap(account, provider)
      const draft = fixture(drafts.compose(fixture(drafts.list()[0]).id))
      const expunge = vi.spyOn(fake, 'uidExpunge')
      const send = vi.spyOn(provider, 'send')
      if (scenario === 'rejected') send.mockRejectedValue(new SmtpRejection('Fixture rejection'))
      else if (scenario === 'reconciled') {
        send.mockRejectedValue(new Error('Lost SMTP response'))
        vi.spyOn(provider, 'findSent').mockResolvedValue({
          folder: 'Sent',
          uidValidity: '1',
          uid: 1,
        })
      } else {
        send.mockResolvedValue({
          messageId: 'sent@example.test',
          accepted: ['reviewed@example.test'],
          rejected: scenario === 'partially accepted' ? ['rejected@example.test'] : [],
          sentCopy: 'server-managed',
        })
      }

      expect(
        (
          await call('/outbox', 'POST', {
            id: 'imap-send',
            draftId: draft.id,
            revision: draft.revision,
          })
        ).status,
      ).toBe(202)
      if (scenario === 'changed on server') {
        const source = fixture(folder.messages.get(uid))
        source.source = Buffer.concat([
          Buffer.from('X-Provider-Header: changed\r\n'),
          source.source,
        ])
      }
      advance(9_999)
      await outbox.runDue()
      await drafts.mirrorPending()
      expect(send).not.toHaveBeenCalled()
      expect(expunge).not.toHaveBeenCalled()
      expect(folder.messages.has(uid)).toBe(true)
      if (scenario === 'cancelled')
        expect((await call('/outbox/imap-send/cancel', 'POST')).ok).toBe(true)

      advance(1)
      await outbox.runDue()
      if (scenario === 'reconciled') {
        expect(outbox.get('imap-send')?.status).toBe('dispatching')
        await drafts.mirrorPending()
        expect(folder.messages.has(uid)).toBe(true)
        advance(15_000)
        await outbox.runDue()
      }
      expect(send).toHaveBeenCalledTimes(scenario === 'cancelled' ? 0 : 1)
      const status =
        scenario === 'cancelled' ? 'cancelled' : scenario === 'rejected' ? 'failed' : 'sent'
      expect(outbox.get('imap-send')?.status).toBe(status)
      expect(folder.messages.has(uid)).toBe(true)
      await drafts.pullImap(account, provider)
      expect(drafts.list()).toHaveLength(
        status === 'sent' && scenario !== 'partially accepted' && scenario !== 'reconciled' ? 0 : 1,
      )

      await drafts.mirrorPending()
      if (scenario === 'accepted') {
        expect(expunge).toHaveBeenCalledExactlyOnceWith(uid)
        await drafts.pullImap(account, provider)
        expect(drafts.list()).toHaveLength(0)
      } else {
        expect(expunge).not.toHaveBeenCalled()
      }
      expect(folder.messages.has(uid)).toBe(scenario !== 'accepted')
    } finally {
      db.close()
    }
  },
)

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
  await drafts.pullImap(account, provider)
  expect(drafts.list()).toHaveLength(1)
  expect(folder.messages.has(originalUid)).toBe(true)
  expect(fake.appended).toHaveLength(0)
  const edited = fixture(drafts.compose(original.id))
  expect(edited.originalDraftLeft).toBe(true)
  const frozen = drafts.freeze(edited.id, edited.revision)
  expect(frozen.subject).toBe('Edited subject')
  expect(frozen.text.replace(/\r\n/g, '\n')).toBe(body.replace(/\r\n/g, '\n'))
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
  const edited = await drafts.update(
    fixture(drafts.list()[0]).id,
    { subject: 'Edited subject' },
    'owner',
  )
  await drafts.mirrorPending()
  expect(folder.messages.has(uid)).toBe(true)
  expect(fake.appended).toHaveLength(0)
  const frozen = drafts.freeze(edited.id, edited.revision)
  const mime = await simpleParser(await buildMessage(frozen), { skipImageLinks: true })
  expect(mime.html).toContain('href="cid:report@example.test"')
  expect(mime.html).toContain('src="cid:logo@example.test"')
  expect(mime.attachments).toEqual([
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

it('replaces only the previous AMC-created mirror when editing an IMAP draft', async () => {
  const { account, addPlainDraft, db, drafts, fake, folder, provider } = imapDraftSetup()
  try {
    const external = addPlainDraft('External draft')
    const original = await drafts.create({ accountId: account, body: 'AMC draft' }, 'owner')
    const oldMirror = fixture([...folder.messages.keys()].find((uid) => uid !== external))
    await drafts.update(original.id, { body: 'AMC edit' }, 'owner')
    await drafts.mirrorPending()
    await drafts.pullImap(account, provider)
    expect(folder.messages.has(oldMirror)).toBe(false)
    expect(folder.messages.has(external)).toBe(true)
    expect(fake.appended).toHaveLength(2)
    expect(
      drafts
        .list()
        .map(({ body }) => body)
        .sort(),
    ).toEqual(['AMC edit', 'External draft'])
  } finally {
    db.close()
  }
})

it('keeps an AMC-created IMAP mirror when its full source changes at the same UID', async () => {
  const { account, db, drafts, fake, folder } = imapDraftSetup()
  const original = await drafts.create({ accountId: account, body: 'Original content' }, 'owner')
  const uid = fixture([...folder.messages.keys()][0])
  const message = fixture(folder.messages.get(uid))
  message.source = Buffer.concat([Buffer.from('X-Provider-Header: changed\r\n'), message.source])

  await drafts.update(original.id, { subject: 'Edited subject' }, 'owner')
  await drafts.mirrorPending()
  expect(folder.messages.has(uid)).toBe(true)
  expect(fake.appended).toHaveLength(2)
  expect(drafts.compose(original.id)?.originalDraftLeft).toBe(true)
  db.close()
})

it.each(['new UID', 'UIDVALIDITY reset'])(
  'rebinds a byte-identical IMAP draft after a %s and leaves the replacement on send',
  async (scenario) => {
    const { account, db, drafts, fake, folder, outbox, provider } = imapDraftSetup()
    try {
      const original = await drafts.create(
        { accountId: account, to: reader, body: 'Draft' },
        'owner',
      )
      const uid = fixture([...folder.messages.keys()][0])
      const raw = fixture(folder.messages.get(uid)).source
      const before = drafts.freeze(original.id, original.revision)
      fake.expunge('Drafts', uid)
      if (scenario === 'UIDVALIDITY reset') {
        folder.validity += 1n
        folder.nextUid = uid
      }
      const replacement = fake.add('Drafts', 'Subject: Fixture', '', ['\\Draft'])
      fixture(folder.messages.get(replacement)).source = raw

      await drafts.pullImap(account, provider)
      await drafts.pullImap(account, provider)
      expect(drafts.list().map(({ id }) => id)).toEqual([original.id])
      const rebound = fixture(drafts.compose(original.id))
      expect(rebound).toMatchObject({ body: original.body, mirrorConflict: false })
      expect(drafts.freeze(rebound.id, rebound.revision).providerDraftId).not.toBe(
        before.providerDraftId,
      )

      const sent = await drafts.prepareSend(
        { id: 'send-rebound', draftId: rebound.id, revision: rebound.revision },
        draftOwner,
        outbox,
      )
      await drafts.pullImap(account, provider)
      expect(sent).toMatchObject({ status: 'queued', originalDraftLeft: true })
      expect(drafts.list()).toHaveLength(1)
      expect([...folder.messages.keys()]).toEqual([replacement])
    } finally {
      db.close()
    }
  },
)

it('keeps distinct IMAP draft UIDs when multiple new copies match the missing source', async () => {
  const { account, addPlainDraft, db, drafts, fake, folder, provider } = imapDraftSetup()
  try {
    const uid = addPlainDraft('Draft')
    const raw = fixture(folder.messages.get(uid)).source
    await drafts.pullImap(account, provider)
    const original = fixture(drafts.list()[0])
    fake.expunge('Drafts', uid)
    for (let i = 0; i < 2; i++) {
      fixture(folder.messages.get(addPlainDraft('Draft'))).source = raw
    }

    await drafts.pullImap(account, provider)
    expect(drafts.list()).toHaveLength(3)
    expect(drafts.compose(original.id)?.mirrorConflict).toBe(true)
    expect(folder.messages.size).toBe(2)
  } finally {
    db.close()
  }
})

it('leaves unsupported MIME on IMAP and flags it on edit and send', async () => {
  const { account, addPlainDraft, advance, db, drafts, fake, folder, outbox, provider } =
    imapDraftSetup()
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
  vi.spyOn(provider, 'send').mockResolvedValue({
    messageId: 'sent@example.test',
    accepted: ['reviewed@example.test'],
    rejected: [],
    sentCopy: 'server-managed',
  })
  advance(10_000)
  await outbox.runDue()
  expect(outbox.get(item.id)?.status).toBe('sent')
  await drafts.mirrorPending()
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
