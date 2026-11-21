import { spawnSync } from 'node:child_process'
import { randomBytes } from 'node:crypto'
import { fileURLToPath } from 'node:url'
import { MessageDetail, SCOPES, ThreadDetail } from '@amc/protocol'
import { describe, expect, it, vi } from 'vitest'
import { issueToken } from '../auth/tokens.ts'
import { BlobStore } from '../blobs.ts'
import { Sealer } from '../crypto.ts'
import { gmailDelivery, publishSent } from '../mail/delivery.ts'
import { Drafts } from '../mail/drafts.ts'
import { Outbox } from '../mail/outbox.ts'
import { MailQueries } from '../mail/queries.ts'
import { MailStore } from '../mail/store.ts'
import { FakeGmail } from '../providers/gmail/fake.ts'
import { fromGmail } from '../providers/gmail/mapping.ts'
import type { ImapCredentials } from '../providers/imap/client.ts'
import { FakeImap } from '../providers/imap/fake.ts'
import { LAZY_ATTACHMENT_THRESHOLD } from '../providers/imap/mapping.ts'
import { ImapProvider } from '../providers/imap/provider.ts'
import { setSetting } from '../settings.ts'
import { SyncManager } from '../sync/manager.ts'
import { silentLog, tempDir, testConfig, testDb } from '../test-support.ts'
import { createApp } from './app.ts'

function setup(
  options: Pick<ConstructorParameters<typeof SyncManager>[0], 'imapClient' | 'imapPollMs'> = {},
) {
  const db = testDb()
  const blobs = new BlobStore(tempDir())
  const store = new MailStore(db, blobs)
  const sealer = new Sealer(randomBytes(32))
  const oauthClient = () => ({ clientId: 'cid', clientSecret: 'secret' })
  const gmail = new FakeGmail()
  const imap = new FakeImap(['CONDSTORE', 'QRESYNC'])
  const verifyImap = vi.fn<(credentials: ImapCredentials) => Promise<void>>().mockResolvedValue()
  const sync = new SyncManager({
    db,
    store,
    sealer,
    log: silentLog,
    oauthClient,
    gmailApi: () => gmail,
    imapClient: () => imap.client,
    pollMs: 10,
    ...options,
  })
  const drafts = new Drafts(db, store, (id) => sync.gmailApi(id))
  const outbox = new Outbox(
    db,
    (id) => {
      const api = sync.gmailApi(id)
      return api ? gmailDelivery(api) : null
    },
    (message, id, receipt) => publishSent(store, drafts, message, id, receipt),
  )
  const app = createApp({
    db,
    config: testConfig(),
    outbox,
    log: silentLog,
    mail: {
      db,
      store,
      queries: new MailQueries(db),
      blobs,
      sealer,
      sync,
      oauthClient,
      verifyImap,
      drafts,
      log: silentLog,
    },
  })
  const admin = issueToken(db, { kind: 'cli', name: 'mac', scopes: ['read', 'admin'] }).secret
  const reader = issueToken(db, { kind: 'agent', name: 'agent', scopes: ['read'] }).secret
  const call = (path: string, token: string, body?: unknown) =>
    app.request(path, {
      method: body === undefined ? 'GET' : 'POST',
      headers: { Authorization: `Bearer ${token}`, 'Content-Type': 'application/json' },
      ...(body === undefined ? {} : { body: JSON.stringify(body) }),
    })
  return { app, db, sealer, store, sync, gmail, imap, verifyImap, call, admin, reader, outbox }
}

const login = {
  address: 'IMAP@example.com',
  imap: {
    host: 'imap.example.com',
    port: 993,
    tls: 'implicit',
    username: 'imap-user',
    password: 'fake-imap-secret',
  },
  smtp: {
    host: 'smtp.example.com',
    port: 587,
    tls: 'starttls',
    username: 'smtp-user',
    password: 'fake-smtp-secret',
  },
}

describe('mail routes', () => {
  it('defers old read bodies on request and preserves full bodies for older clients', async () => {
    const { db, store, gmail, call, reader } = setup()
    db.prepare(
      "INSERT INTO account (id, kind, address, credentials, created_at) VALUES ('a', 'gmail', 'owner@example.com', x'00', 0)",
    ).run()
    const body = 'Long message text. '.repeat(20_000)
    for (const n of [6, 3, 2, 1, 5, 4]) {
      const message = gmail.add(`m${n}`, {
        threadId: 'thread',
        labels: n === 2 ? ['INBOX', 'UNREAD'] : ['INBOX'],
        body: `${body}\0End ${n}`,
        date: n === 4 ? 3000 : n * 1000,
      })
      store.putMessage('a', ['owner@example.com'], fromGmail(message))
    }

    const response = await call('/v1/threads/a%3Athread?deferBodies=1', reader)
    expect(response.status).toBe(200)
    const thread = ThreadDetail.parse(await response.json())
    expect(thread.messages.map((m) => m.id)).toEqual([
      'a:m1',
      'a:m2',
      'a:m3',
      'a:m4',
      'a:m5',
      'a:m6',
    ])
    expect(thread.messages.map((m) => m.bodyText === null)).toEqual([
      true,
      false,
      true,
      false,
      false,
      false,
    ])
    expect(thread.messages[0]).toMatchObject({
      from: { name: 'Alice', address: 'alice@example.com' },
      snippet: body.slice(0, 50),
      unread: false,
    })

    const older = await call('/v1/messages/a%3Am1', reader)
    expect(older.status).toBe(200)
    expect(MessageDetail.parse(await older.json()).bodyText).toBe(`${body}\0End 1`)
    const full = await call('/v1/threads/a%3Athread', reader)
    expect(ThreadDetail.parse(await full.json()).messages[0]?.bodyText).toBe(`${body}\0End 1`)
    expect((await call('/v1/messages/missing', reader)).status).toBe(404)
  })

  it('verifies IMAP/SMTP under admin, seals the login, and syncs Inbox updates alongside Gmail', async () => {
    const { db, sealer, sync, gmail, imap, verifyImap, call, admin, reader } = setup()
    try {
      expect((await call('/v1/accounts/imap', reader, login)).status).toBe(403)
      expect(verifyImap).not.toHaveBeenCalled()
      verifyImap.mockRejectedValueOnce(new Error(login.imap.password))
      const rejected = await call('/v1/accounts/imap', admin, login)
      expect(rejected.status).toBe(400)
      expect(await rejected.text()).not.toContain(login.imap.password)
      expect(db.prepare('SELECT id FROM account').all()).toHaveLength(0)

      gmail.add('m1', { subject: 'Gmail subject' })
      db.prepare(
        "INSERT INTO account (id, kind, address, credentials, created_at) VALUES ('g', 'gmail', 'owner@example.com', ?, 0)",
      ).run(sealer.seal({ refreshToken: 'r', scope: 's' }))
      sync.start()
      imap.addFolder('Remote Archive', '\\Archive')
      const added = await call('/v1/accounts/imap', admin, login)
      expect(added.status).toBe(200)
      const result = (await added.json()) as { accountId: string }
      expect(result).toEqual({
        accountId: expect.any(String),
        address: 'imap@example.com',
        created: true,
      })
      const row = db
        .prepare('SELECT kind, credentials FROM account WHERE id = ?')
        .get(result.accountId)
      expect(row?.kind).toBe('imap')
      const sealed = row?.credentials as Uint8Array
      expect(Buffer.from(sealed).toString()).not.toContain(login.imap.password)
      const credentials = { imap: login.imap, smtp: login.smtp, smtpSavesSent: false }
      expect(verifyImap).toHaveBeenLastCalledWith(credentials)
      expect(sealer.open(sealed)).toEqual(credentials)
      await vi.waitFor(() => {
        const mailbox = imap.mailbox
        expect(mailbox === false ? '' : mailbox.path).toBe('INBOX')
      })
      imap.add('INBOX', 'Subject: Pushed message')
      await vi.waitFor(async () => {
        const response = await call('/v1/threads?inbox=1', reader)
        const { threads } = (await response.json()) as { threads: { subject: string }[] }
        expect(threads.map((thread) => thread.subject)).toEqual(
          expect.arrayContaining(['Gmail subject', 'Pushed message']),
        )
      })
      const getAccountSnapshot = async () =>
        (await call('/v1/sync/snapshot?entity=account', reader)).text()
      await vi.waitFor(async () => {
        expect(JSON.parse(await getAccountSnapshot()).rows).toContainEqual(
          expect.objectContaining({ kind: 'imap', status: 'ready', messageCount: 1 }),
        )
      })
      const accountSnapshot = await getAccountSnapshot()
      for (const secret of [
        login.imap.password,
        login.smtp.password,
        login.imap.username,
        login.smtp.host,
      ]) {
        expect(accountSnapshot).not.toContain(secret)
      }
      const labelSnapshot = await (await call('/v1/sync/snapshot?entity=label', reader)).json()
      expect(labelSnapshot).toMatchObject({
        rows: expect.arrayContaining([
          expect.objectContaining({ providerId: 'ARCHIVE', accountId: result.accountId }),
        ]),
      })
    } finally {
      await sync.stop()
    }
  })

  it('starts a Google sign-in only for loopback redirects and only with admin', async () => {
    const { call, admin, reader } = setup()
    const ok = await call('/v1/accounts/gmail/start', admin, {
      redirectUri: 'http://127.0.0.1:5555/callback',
    })
    expect(ok.status).toBe(200)
    const { authUrl } = (await ok.json()) as { authUrl: string }
    const url = new URL(authUrl)
    expect(url.searchParams.get('code_challenge_method')).toBe('S256')
    expect(url.searchParams.get('scope')).toContain('gmail.modify')
    expect(
      (await call('/v1/accounts/gmail/start', admin, { redirectUri: 'https://evil.example/cb' }))
        .status,
    ).toBe(400)
    expect(
      (await call('/v1/accounts/gmail/start', reader, { redirectUri: 'http://127.0.0.1:1/cb' }))
        .status,
    ).toBe(403)
  })

  it('refuses to complete a sign-in with an unknown state', async () => {
    const { call, admin } = setup()
    const res = await call('/v1/accounts/gmail/complete', admin, { code: 'c', state: 'nope' })
    expect(res.status).toBe(400)
  })

  it('syncs an Account and serves Threads, search and attachments', async () => {
    const { db, sealer, sync, gmail, call, reader } = setup()
    gmail.add('m1', { subject: 'Quarterly numbers', body: 'Revenue is up' })
    const m = gmail.messages.get('m1')
    if (m?.payload) {
      m.payload = {
        mimeType: 'multipart/mixed',
        headers: m.payload.headers ?? [],
        parts: [
          {
            mimeType: 'text/plain',
            body: { size: 3, data: Buffer.from('Revenue is up').toString('base64url') },
          },
          {
            mimeType: 'application/pdf',
            filename: 'q3.pdf',
            body: { size: 3, attachmentId: 'att' },
          },
        ],
      }
    }
    db.prepare(
      "INSERT INTO account (id, kind, address, credentials, created_at) VALUES ('a', 'gmail', 'owner@example.com', ?, 0)",
    ).run(sealer.seal({ refreshToken: 'r', scope: 's' }))
    sync.startAccount('a')
    await new Promise((resolve) => setTimeout(resolve, 100))

    const threads = (await (await call('/v1/threads?inbox=1', reader)).json()) as {
      threads: { id: string }[]
    }
    expect(threads.threads.map((t) => t.id)).toEqual(['a:t-m1'])
    const hits = (await (await call('/v1/search?q=revenue', reader)).json()) as {
      hits: { id: string }[]
    }
    expect(hits.hits).toHaveLength(1)
    const thread = (await (await call('/v1/threads/a:t-m1', reader)).json()) as {
      messages: { attachments: { id: string }[] }[]
    }
    const attachmentId = thread.messages[0]?.attachments[0]?.id ?? ''
    const file = await call(`/v1/attachments/${attachmentId}`, reader)
    expect(file.status).toBe(200)
    expect(new Uint8Array(await file.arrayBuffer())).toEqual(new Uint8Array([1, 2, 3]))
    const accounts = (await (await call('/v1/accounts', reader)).json()) as {
      accounts: { status: string }[]
    }
    expect(accounts.accounts[0]?.status).toBe('ready')
    await sync.stop()
  })
})

it.each([
  { host: 'other.example.com' },
  { port: 1993 },
  { username: 'other' },
  { tls: 'starttls' },
])('resets the cache when the verified IMAP endpoint changes to %j', async (endpoint) => {
  const first = new FakeImap(['CONDSTORE'])
  const next = new FakeImap(['CONDSTORE'])
  first.add('INBOX', 'Subject: Old endpoint')
  next.add('INBOX', 'Subject: New endpoint')
  const { call, admin, reader, sync } = setup({
    imapClient: (settings) => {
      const newEndpoint = Object.entries(endpoint).every(
        ([key, value]) => settings[key as keyof typeof settings] === value,
      )
      return (newEndpoint ? next : first).client
    },
  })
  async function subjects() {
    const { threads } = (await (await call('/v1/threads', reader)).json()) as {
      threads: { subject: string }[]
    }
    return threads.map(({ subject }) => subject)
  }
  try {
    const initial = (await (await call('/v1/accounts/imap', admin, login)).json()) as {
      accountId: string
    }
    await vi.waitFor(async () => expect(await subjects()).toEqual(['Old endpoint']))
    const changed = await call('/v1/accounts/imap', admin, {
      ...login,
      imap: { ...login.imap, ...endpoint },
    })
    expect(changed.status).toBe(200)
    expect(await changed.json()).toMatchObject({ accountId: initial.accountId, created: false })
    await vi.waitFor(async () => expect(await subjects()).toEqual(['New endpoint']))
  } finally {
    await sync.stop()
  }
})

it('releases a one-session mailbox for verification and resumes after failure and success', async () => {
  const { imap, sync, verifyImap, call, admin } = setup()
  const connect = imap.connect.bind(imap)
  imap.connect = async () => {
    if (imap.usable) throw new Error('Mailbox permits one connection')
    await connect()
  }
  verifyImap.mockImplementation(async ({ imap: credentials }) => {
    await imap.connect()
    try {
      await imap.mailboxOpen('INBOX')
      if (credentials.password === 'bad') throw new Error('Invalid test login')
    } finally {
      imap.close()
    }
  })
  try {
    expect((await call('/v1/accounts/imap', admin, login)).status).toBe(200)
    await vi.waitFor(() => expect(imap.idles.length).toBeGreaterThan(0))
    expect(imap.usable).toBe(true)
    const bad = { ...login, imap: { ...login.imap, password: 'bad' } }
    expect((await call('/v1/accounts/imap', admin, bad)).status).toBe(400)
    await vi.waitFor(() => expect(imap.idles.length).toBeGreaterThan(1))
    expect(imap.usable).toBe(true)
    expect((await call('/v1/accounts/imap', admin, login)).status).toBe(200)
    await vi.waitFor(() => expect(imap.idles.length).toBeGreaterThan(2))
  } finally {
    await sync.stop()
  }
})

it.each([false, true])(
  'streams a lazy attachment from the surviving IMAP copy (refresh locations: %s)',
  async (refreshLocations) => {
    const { db, imap, call, sync, admin, reader } = setup()
    const bytes = Buffer.alloc(LAZY_ATTACHMENT_THRESHOLD + 20, 'x')
    const encoded = bytes
      .toString('base64')
      .match(/.{1,76}/g)
      ?.join('\r\n')
    const headers = [
      'Subject: Huge file',
      'Message-ID: <huge-file@example.com>',
      'Content-Type: multipart/mixed; boundary="file"',
    ].join('\r\n')
    const mime = [
      '--file',
      'Content-Type: text/plain',
      '',
      'Body from the source',
      '--file',
      'Content-Type: application/octet-stream',
      'Content-Disposition: attachment; filename="huge.bin"',
      'Content-Transfer-Encoding: base64',
      '',
      encoded,
      '--file--',
    ].join('\r\n')
    imap.addFolder('Archive', '\\Archive')
    const copy = (path: string) => {
      const uid = imap.add(path, headers, mime)
      const item = imap.folder(path).messages.get(uid)
      if (!item) throw new Error('Missing fake MIME fixture')
      item.structure = {
        type: 'multipart/mixed',
        childNodes: [
          { type: 'text/plain', part: '1' },
          {
            type: 'application/octet-stream',
            part: '2',
            size: bytes.length,
            disposition: 'attachment',
            dispositionParameters: { filename: 'huge.bin' },
          },
        ],
      }
      item.parts = new Map([['2', bytes]])
      return uid
    }
    const inbox = copy('INBOX')
    const archive = copy('Archive')
    try {
      expect((await call('/v1/accounts/imap', admin, login)).status).toBe(200)
      await vi.waitFor(
        () =>
          expect(db.prepare('SELECT count(*) AS count FROM imap_location').get()?.count).toBe(2),
        { timeout: 5_000 },
      )
      const row = db.prepare('SELECT id, blob, provider_attachment FROM attachment').get()
      expect(row).toMatchObject({ blob: null, provider_attachment: '2' })
      expect(imap.downloads.map(({ part }) => part)).toEqual([undefined, undefined])
      expect(db.prepare('SELECT body_text FROM message').get()?.body_text).toBe(
        'Body from the source',
      )

      imap.onDownload = (folder, uid, part) => {
        if (folder !== 'Archive' || part !== '2') return
        imap.expunge(folder, uid)
        if (refreshLocations) {
          db.prepare("UPDATE imap_location SET uid = ? WHERE path_key = 'INBOX'").run(inbox)
        }
      }
      if (refreshLocations) {
        // The first lookup still has an outdated Inbox UID. The correct UID appears after
        // that attempt, so a fresh lookup must discover it.
        db.prepare("UPDATE imap_location SET uid = 99 WHERE path_key = 'INBOX'").run()
      }
      const path = `/v1/attachments/${row?.id}`
      const response = await call(path, reader)
      expect(response.status).toBe(200)
      expect(Number(response.headers.get('content-length'))).toBe(bytes.length)
      expect(Buffer.from(await response.arrayBuffer()).equals(bytes)).toBe(true)
      const again = await call(path, reader)
      await again.body?.cancel()
      expect(imap.downloads.filter(({ part }) => part)).toEqual([
        { path: 'Archive', uid: archive, part: '2' },
        ...(refreshLocations ? [{ path: 'INBOX', uid: 99, part: '2' }] : []),
        { path: 'INBOX', uid: inbox, part: '2' },
      ])
    } finally {
      await sync.stop()
    }
  },
  15_000,
)

it('has no SMTP submission dispatch through Agent tokens, HTTP, MCP or the CLI (ADR 0001)', async () => {
  const { app, call, admin, db, imap, sync, outbox, gmail } = setup()
  const submit = vi
    .spyOn(ImapProvider.prototype, 'send')
    .mockRejectedValue(new Error('Unexpected send'))
  const gmailSend = vi.spyOn(gmail, 'sendMessage')
  const limited = issueToken(db, {
    kind: 'agent',
    name: 'agent',
    scopes: SCOPES.filter((scope) => scope !== 'send'),
  }).secret
  setSetting(db, 'dangerouslyAllowSend', true)
  const agent = issueToken(db, {
    kind: 'agent',
    name: 'agent with send scope',
    scopes: SCOPES,
  }).secret
  try {
    expect((await call('/v1/accounts/imap', admin, login)).status).toBe(200)
    const account = db.prepare('SELECT id FROM account').get()?.id
    const args = {
      accountId: account,
      to: ['recipient@example.com'],
      subject: 'Synthetic',
      text: 'Synthetic',
    }
    for (const token of [limited, agent, admin]) {
      for (const path of [
        '/v1/send',
        '/v1/messages/send',
        '/v1/drafts/draft-id/send',
        `/v1/accounts/${account}/send`,
      ]) {
        expect((await call(path, token, args)).status).toBe(404)
      }
      for (const endpoint of [
        '/outbox',
        '/outbox/item/cancel',
        '/outbox/item/resolve',
        '/drafts',
      ]) {
        expect((await call(`/v1/compose${endpoint}`, token, args)).status).toBe(403)
      }
      expect((await call('/v1/compose/outbox', token)).status).toBe(403)
      for (const name of ['send', 'send_mail', 'send_message', 'send_draft']) {
        const reply = await app.request('/mcp', {
          method: 'POST',
          headers: {
            Authorization: `Bearer ${token}`,
            'Content-Type': 'application/json',
            Accept: 'application/json, text/event-stream',
          },
          body: JSON.stringify({
            jsonrpc: '2.0',
            id: 1,
            method: 'tools/call',
            params: { name, arguments: args },
          }),
        })
        expect(await reply.json()).toMatchObject({ result: { isError: true } })
      }
    }

    const entry = fileURLToPath(new URL('../../../cli/src/main.ts', import.meta.url))
    for (const command of [['send'], ['draft', 'send', 'draft-id']]) {
      const processResult = spawnSync(process.execPath, [entry, ...command], {
        encoding: 'utf8',
        env: {
          ...process.env,
          XDG_CONFIG_HOME: tempDir(),
          AMC_ENGINE_URL: 'http://127.0.0.1:1',
          AMC_TOKEN: agent,
        },
      })
      expect(processResult.status).toBe(1)
      expect(processResult.stderr).toContain('unknown command')
    }
    await outbox.runDue()
    expect(db.prepare('SELECT COUNT(*) AS n FROM outbox').get()?.n).toBe(0)
    expect(gmailSend).not.toHaveBeenCalled()
    expect(submit).not.toHaveBeenCalled()
    expect(imap.appended).toHaveLength(0)
  } finally {
    gmailSend.mockRestore()
    submit.mockRestore()
    await sync.stop()
  }
})

it('backs off repeated early IDLE disconnects and resets after a stable minute', async () => {
  vi.useFakeTimers()
  const attempts: number[] = []
  const start = Date.now()
  let stayConnected = false
  const { sync, call, admin } = setup({
    imapClient: () => {
      attempts.push(Date.now() - start)
      const imap = new FakeImap()
      imap.onIdle = () => {
        if (!stayConnected) imap.close()
        else setTimeout(() => imap.close(), 61_000)
      }
      return imap.client
    },
  })
  try {
    expect((await call('/v1/accounts/imap', admin, login)).status).toBe(200)
    await vi.advanceTimersByTimeAsync(14_999)
    expect(attempts).toEqual([0, 5_000])
    stayConnected = true
    await vi.advanceTimersByTimeAsync(62_001)
    expect(attempts).toEqual([0, 5_000, 15_000])
    stayConnected = false
    await vi.advanceTimersByTimeAsync(4_000)
    expect(attempts).toEqual([0, 5_000, 15_000, 81_000])
  } finally {
    await sync.stop()
    vi.useRealTimers()
  }
})

it('processes an Inbox delivery from IDLE before the first Archive backfill page', async () => {
  const { db, imap, sync, call, admin } = setup()
  imap.addFolder('Archive', '\\Archive')
  imap.add('Archive', 'Subject: Archive backfill')
  imap.onIdle = () => {
    if (imap.idles.length === 1) imap.add('INBOX', 'Subject: First IDLE delivery')
  }
  const firstArchive = vi.fn()
  const download = imap.download.bind(imap)
  imap.download = async (...args) => {
    if (imap.mailbox && imap.mailbox.path === 'Archive') {
      firstArchive(db.prepare('SELECT subject FROM message ORDER BY rowid').all())
    }
    return download(...args)
  }
  try {
    expect((await call('/v1/accounts/imap', admin, login)).status).toBe(200)
    await vi.waitFor(() =>
      expect(firstArchive).toHaveBeenCalledWith([{ subject: 'First IDLE delivery' }]),
    )
    expect(imap.idles[0]).toBe('INBOX')
  } finally {
    await sync.stop()
  }
})
