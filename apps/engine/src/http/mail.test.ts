import { randomBytes } from 'node:crypto'
import { describe, expect, it, vi } from 'vitest'
import { issueToken } from '../auth/tokens.ts'
import { BlobStore } from '../blobs.ts'
import { Sealer } from '../crypto.ts'
import { Drafts } from '../mail/drafts.ts'
import { MailQueries } from '../mail/queries.ts'
import { MailStore } from '../mail/store.ts'
import { FakeGmail } from '../providers/gmail/fake.ts'
import type { ImapCredentials } from '../providers/imap/client.ts'
import { FakeImap } from '../providers/imap/fake.ts'
import { SyncManager } from '../sync/manager.ts'
import { silentLog, tempDir, testConfig, testDb } from '../test-support.ts'
import { createApp } from './app.ts'

function setup() {
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
  })
  const app = createApp({
    db,
    config: testConfig(),
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
      drafts: new Drafts(db, store, (id) => sync.gmailApi(id)),
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
  return { db, sealer, sync, gmail, imap, verifyImap, call, admin, reader }
}

describe('mail routes', () => {
  it('verifies IMAP/SMTP under admin, seals the login, and syncs Inbox updates alongside Gmail', async () => {
    const { db, sealer, sync, gmail, imap, verifyImap, call, admin, reader } = setup()
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
      const accountSnapshot = await (await call('/v1/sync/snapshot?entity=account', reader)).text()
      expect(JSON.parse(accountSnapshot).rows).toContainEqual(
        expect.objectContaining({ kind: 'imap', status: 'ready', messageCount: 1 }),
      )
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
