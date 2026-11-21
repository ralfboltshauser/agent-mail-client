import { mkdirSync } from 'node:fs'
import { describe, expect, it } from 'vitest'
import { createPairingCode, DAY_MS, issueToken } from '../auth/tokens.ts'
import { MIGRATIONS } from '../db/migrations.ts'
import { silentLog, testConfig, testDb } from '../test-support.ts'
import { createApp } from './app.ts'

function setup(configOverrides = {}) {
  const db = testDb()
  const config = testConfig(configOverrides)
  const app = createApp({ db, config, log: silentLog })
  return { db, app, config }
}

describe('HTTP API', () => {
  it('serves public health without a token', async () => {
    const { app } = setup()
    const res = await app.request('/health')
    expect(res.status).toBe(200)
    expect(await res.json()).toMatchObject({ ok: true })
  })

  it('requires a token for /v1', async () => {
    const { app } = setup()
    expect((await app.request('/v1/me')).status).toBe(401)
    expect(
      (await app.request('/v1/me', { headers: { Authorization: 'Bearer amc_bad' } })).status,
    ).toBe(401)
  })

  it('pairs a device and then knows who it is', async () => {
    const { db, app } = setup()
    const code = createPairingCode(db, 'cli')
    const pair = await app.request('/v1/auth/pair', {
      method: 'POST',
      body: JSON.stringify({ code, deviceName: 'mac' }),
      headers: { 'Content-Type': 'application/json' },
    })
    expect(pair.status).toBe(200)
    const { token } = (await pair.json()) as { token: string }
    const me = await app.request('/v1/me', { headers: { Authorization: `Bearer ${token}` } })
    expect(await me.json()).toMatchObject({ kind: 'cli', name: 'mac' })
  })

  it('reports detailed health to a token with read', async () => {
    const { db, app, config } = setup()
    mkdirSync(config.backupDir)
    db.exec(`
      INSERT INTO account (id, kind, address, credentials, status, last_sync_at, last_error, created_at)
      VALUES ('a', 'gmail', 'test@example.com', X'00', 'error', 0, 'test error', 0);
      INSERT INTO mutation (id, principal, account_id, thread_id, request, status)
      VALUES ('m1', 'p', 'a', 't', '{}', 'pending'), ('m2', 'p', 'a', 't', '{}', 'applied');
      INSERT INTO outbox (id, draft_id, account_id, revision, rfc_id, subject, to_json, send_at, undo_until, status, next_at)
      VALUES ('o1', 'd1', 'a', 1, 'r1', 'queued', '[]', 0, 0, 'queued', 0),
             ('o2', 'd2', 'a', 1, 'r2', 'dispatching', '[]', 0, 0, 'dispatching', 0),
             ('o3', 'd3', 'a', 1, 'r3', 'sent', '[]', 0, 0, 'sent', 0);
    `)
    const { secret } = issueToken(db, { kind: 'cli', name: 'mac', scopes: ['read'] })
    const res = await app.request('/v1/health', { headers: { Authorization: `Bearer ${secret}` } })
    expect(res.status).toBe(200)
    expect(await res.json()).toMatchObject({
      ok: true,
      schemaVersion: MIGRATIONS.length,
      lastBackup: null,
      accounts: [
        {
          address: 'test@example.com',
          status: 'error',
          syncLagSeconds: expect.any(Number),
          lastError: 'test error',
        },
      ],
      outboxDepth: 2,
      mutationQueueDepth: 1,
      disks: expect.arrayContaining([expect.objectContaining({ path: config.backupDir })]),
    })
  })

  it('enforces scopes', async () => {
    const { db, app } = setup()
    const { secret } = issueToken(db, {
      kind: 'agent',
      expiresAt: Date.now() + DAY_MS,
      name: 'x',
      scopes: ['draft'],
    })
    const res = await app.request('/v1/health', { headers: { Authorization: `Bearer ${secret}` } })
    expect(res.status).toBe(403)
  })

  it('grants one triage lease across clients and releases or expires it', async () => {
    const { db, app } = setup()
    const desktop = issueToken(db, { kind: 'desktop', name: 'Mac', scopes: ['admin'] })
    const cli = issueToken(db, { kind: 'cli', name: 'Host', scopes: ['admin'] })
    const lease = (holder: string, secret: string, method = 'POST') =>
      app.request('/v1/triage/lease', {
        method,
        headers: { Authorization: `Bearer ${secret}`, 'Content-Type': 'application/json' },
        body: JSON.stringify({ holder }),
      })
    const fromDesktop = (method?: string) => lease('desktop', desktop.secret, method)
    const fromCli = (method?: string) => lease('cli', cli.secret, method)
    const [desktopResult, cliResult] = await Promise.all([fromDesktop(), fromCli()])
    const { granted: desktopWon } = await desktopResult.json()
    expect(await cliResult.json()).toEqual({ granted: !desktopWon })
    const winner = desktopWon ? fromDesktop : fromCli
    const loser = desktopWon ? fromCli : fromDesktop
    const winnerName = desktopWon ? 'desktop' : 'cli'

    await loser('DELETE')
    expect(await (await loser()).json()).toEqual({ granted: false })
    await winner('DELETE')
    expect(await (await loser()).json()).toEqual({ granted: true })
    expect(db.prepare('SELECT expires_at FROM triage_lease').get()?.expires_at).toBeGreaterThan(
      Date.now() + 9 * 60_000,
    )
    db.exec('UPDATE triage_lease SET expires_at = 0')
    expect(await (await winner()).json()).toEqual({ granted: true })
    await loser('DELETE')
    expect(db.prepare('SELECT holder FROM triage_lease').get()?.holder).toBe(winnerName)
  })

  it('issues an expiring scoped Agent grant and lets the owner revoke it', async () => {
    const { db, app } = setup()
    db.exec(
      "INSERT INTO account (id, kind, address, credentials, created_at) VALUES ('a', 'gmail', 'owner@example.com', x'00', 0)",
    )
    const owner = issueToken(db, { kind: 'cli', name: 'Mac', scopes: ['admin'] })
    const headers = { Authorization: `Bearer ${owner.secret}`, 'Content-Type': 'application/json' }
    const create = (data: Record<string, unknown>) =>
      app.request('/v1/tokens', {
        headers,
        method: 'POST',
        body: JSON.stringify({ name: 'Agent', scopes: ['organize'], ...data }),
      })
    expect((await create({})).status).toBe(400)
    expect((await create({ expiresInDays: 91 })).status).toBe(400)
    expect((await create({ expiresInMinutes: 61 })).status).toBe(400)
    expect((await create({ expiresInDays: 30, expiresInMinutes: 5 })).status).toBe(400)
    expect((await create({ expiresInMinutes: 5, accountId: 'a' })).status).toBe(200)
    expect((await create({ expiresInDays: 30, scopes: ['send'] })).status).toBe(403)
    expect((await create({ expiresInDays: 30, accountId: 'unknown' })).status).toBe(403)
    const response = await create({ expiresInDays: 30, accountId: 'a' })
    expect(response.status).toBe(200)
    const { id, token } = (await response.json()) as { id: string; token: string }
    expect(await (await app.request('/v1/tokens', { headers })).json()).toMatchObject({
      tokens: expect.arrayContaining([
        expect.objectContaining({ id, account_id: 'a', expires_at: expect.any(Number) }),
      ]),
    })
    const grantHeaders = { Authorization: `Bearer ${token}` }
    expect((await app.request('/v1/me', { headers: grantHeaders })).status).toBe(200)
    expect((await app.request(`/v1/tokens/${id}`, { method: 'DELETE', headers })).status).toBe(200)
    expect((await app.request('/v1/me', { headers: grantHeaders })).status).toBe(401)
    db.prepare('UPDATE token SET expires_at = NULL WHERE id = ?').run(id)
    expect(await (await app.request('/v1/me', { headers: grantHeaders })).json()).toMatchObject({
      message: expect.stringMatching(/re-issue/),
    })
  })

  it('refuses tailnet logins that are not allowed', async () => {
    const { app } = setup({ allowedTailscaleLogins: ['owner@example.com'] })
    const other = await app.request('/health', {
      headers: { 'Tailscale-User-Login': 'eve@example.com' },
    })
    expect(other.status).toBe(403)
    const owner = await app.request('/health', {
      headers: { 'Tailscale-User-Login': 'owner@example.com' },
    })
    expect(owner.status).toBe(200)
  })
})
