import { Diagnostics } from '@amc/protocol'
import { expect, it } from 'vitest'
import { issueToken } from '../auth/tokens.ts'
import { EngineDiagnostics } from '../db/diagnostics.ts'
import { createLogger } from '../log.ts'
import { testConfig, testDb } from '../test-support.ts'
import { createApp } from './app.ts'

it('projects only classified observations for the owner and resets process state after restart', async () => {
  const db = testDb()
  const config = testConfig()
  const accountId = 'acc_0123456789ab'
  const canaries = [
    'diag-private@example.invalid',
    'Diagnostic Synthetic Subject',
    'Diagnostic Synthetic Body',
    'Diagnostic Synthetic Name',
    'Diagnostic Synthetic Reason',
    'diagnostic-synthetic-file.pdf',
    'https://example.invalid/mail?diagnostic=private',
    'diagnostic-synthetic-authorization',
  ]
  const raw = canaries.join(' ')
  db.prepare(`INSERT INTO account (id, kind, address, credentials, created_at, last_sync_at, last_error)
    VALUES (?, 'imap', ?, ?, 1, 2, ?)`).run(accountId, canaries[0] ?? '', Buffer.from(raw), raw)
  const owner = issueToken(db, { kind: 'cli', name: raw, scopes: ['admin'] }).secret
  const agent = issueToken(db, {
    kind: 'agent',
    name: raw,
    scopes: ['read'],
    expiresAt: Date.now() + 60_000,
  }).secret
  const boundAgent = issueToken(db, {
    kind: 'agent',
    name: raw,
    scopes: ['read'],
    accountId,
    expiresAt: Date.now() + 60_000,
  }).secret
  const diagnostics = new EngineDiagnostics()
  const records: string[] = []
  const logRoutes = new Set<string>()
  const log = createLogger('debug', logRoutes, (line) => records.push(line))
  const app = createApp({ db, config, log, logRoutes, diagnostics })
  const request = (target: typeof app, token?: string) =>
    target.request(`/v1/diagnostics?url=${encodeURIComponent(raw)}`, {
      headers: { ...(token && { Authorization: `Bearer ${token}` }), 'x-amc-request-id': raw },
    })
  expect((await request(app)).status).toBe(401)
  expect((await request(app, agent)).status).toBe(403)
  expect((await request(app, boundAgent)).status).toBe(403)

  const unknown = { lastSuccessAt: null, lastFailure: null, successes: 0, failures: 0 }
  const error = new TypeError(raw)
  Object.assign(error, { code: raw, stack: raw, cause: raw })
  const sync = diagnostics.account(diagnostics.sync, accountId)
  sync.failure(error)
  sync.failure(error)
  sync.success()
  diagnostics.pubSub.failure(error)
  diagnostics.migrations.success()
  const response = await request(app, owner)
  expect(response.status).toBe(200)
  expect(response.headers.get('Cache-Control')).toBe('no-store')
  const bytes = await response.text()
  const result = Diagnostics.parse(JSON.parse(bytes))
  expect(result.syncAccounts).toEqual([
    {
      accountId,
      status: {
        lastSuccessAt: expect.any(String),
        lastFailure: { at: expect.any(String), errorClass: 'TypeError' },
        successes: 1,
        failures: 2,
      },
    },
  ])
  expect(result.imapIdle).toEqual([{ accountId, status: unknown }])
  expect(result.pubSub.lastFailure?.errorClass).toBe('TypeError')
  expect(result.migrations.successes).toBe(1)
  expect(result.purge).toEqual(unknown)
  expect(result.outbox).toEqual(unknown)
  expect(result.queues).toEqual({ mutations: 0, outbox: 0, purge: 0 })
  expect(result.schemaVersion).toBeGreaterThan(0)
  expect(result.uptimeSeconds).toBeGreaterThanOrEqual(0)
  expect(records.map((line) => JSON.parse(line))).toContainEqual(
    expect.objectContaining({
      event: 'http.request',
      route: '/v1/diagnostics',
      status: 200,
    }),
  )
  for (const canary of [...canaries, owner, agent, boundAgent]) {
    expect(bytes).not.toContain(canary)
    expect(records.join('\n')).not.toContain(canary)
  }

  const restarted = createApp({ db, config, log, logRoutes })
  const afterRestart = Diagnostics.parse(await (await request(restarted, owner)).json())
  expect(afterRestart.syncAccounts).toEqual([{ accountId, status: unknown }])
  expect(afterRestart.pubSub).toEqual(unknown)
  expect(afterRestart.migrations).toEqual(unknown)
  db.close()
})
