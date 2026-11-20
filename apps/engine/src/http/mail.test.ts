import { randomBytes } from 'node:crypto'
import { describe, expect, it } from 'vitest'
import { issueToken } from '../auth/tokens.ts'
import { BlobStore } from '../blobs.ts'
import { Sealer } from '../crypto.ts'
import { MailQueries } from '../mail/queries.ts'
import { MailStore } from '../mail/store.ts'
import { FakeGmail } from '../providers/gmail/fake.ts'
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
  const sync = new SyncManager({
    db,
    store,
    sealer,
    log: silentLog,
    oauthClient,
    gmailApi: () => gmail,
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
  return { db, sealer, sync, gmail, call, admin, reader }
}

describe('mail routes', () => {
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
