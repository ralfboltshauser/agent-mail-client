import { mkdtemp, rm, writeFile } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { privateHealthWarnings } from '@amc/protocol'
import { afterEach, beforeEach, expect, it, vi } from 'vitest'
import type { SyncStatus } from '../shared/api'
import { desktopDiagnostics } from './diagnostics'
import { EngineError } from './engine'

const privateFields = {
  subject: 'Synthetic Subject Canary',
  body: 'Synthetic Body Canary',
  address: 'diagnostics-canary@example.test',
  displayName: 'Synthetic Display Name Canary',
  token: 'diagnostics_secret_canary',
  url: 'https://example.test/private?token=diagnostics_secret_canary',
}
const privateText = Object.values(privateFields).join(' ')
const sync: SyncStatus = {
  phase: 'live',
  engineUrl: privateFields.url,
  progress: null,
  lastSyncAt: 42,
  error: privateText,
  healthWarnings: [privateText, privateHealthWarnings.lowDiskSpace],
  healthRefreshFailed: false,
}
const status = {
  lastSuccessAt: null,
  lastFailure: null,
  successes: 0,
  failures: 0,
}
const engineSnapshot = {
  version: '1.2.3',
  schemaVersion: 24,
  uptimeSeconds: 50,
  queues: { mutations: 2, outbox: 0, purge: 1, ...privateFields },
  syncAccounts: [{ accountId: 'acc_abcdefgh1234', status, ...privateFields }],
  imapIdle: [],
  pubSub: { ...status, ...privateFields },
  purge: status,
  outbox: status,
  migrations: status,
  ...privateFields,
}

let directory: string
beforeEach(async () => {
  directory = await mkdtemp(join(tmpdir(), 'amc-copy-diagnostics-test-'))
})
afterEach(async () => {
  await rm(directory, { recursive: true, force: true })
})

function collect(authenticatedGet: () => Promise<Response>, readCliVersion = async () => '0.2.0') {
  return desktopDiagnostics({
    directory,
    desktopVersion: '0.1.0',
    readCliVersion,
    engine: { authenticatedGet },
    sync,
  })
}

it('copies only projected diagnostics and the newest 50 warn or error records', async () => {
  const now = Date.now()
  const lines = Array.from({ length: 60 }, (_, i) => ({
    ts: new Date(now - 1000 + i).toISOString(),
    component: 'main',
    event: 'desktop.http.failed',
    stage: 'request',
    level: i % 2 ? 'warn' : 'error',
    err: { class: 'Error', code: privateText, message: privateText, stack: [privateText] },
    msg: privateText,
    ...privateFields,
  }))
  await writeFile(
    join(directory, 'main.log'),
    [privateText, JSON.stringify({ ...lines[59], level: 'info' }), ''].join('\n'),
  )
  await writeFile(
    join(directory, 'main.log.1'),
    [...lines.map((line) => JSON.stringify(line)), ''].join('\n'),
  )
  const authenticatedGet = vi.fn(async () => Response.json(engineSnapshot))
  const json = await collect(authenticatedGet)
  const snapshot = JSON.parse(json)
  expect(authenticatedGet).toHaveBeenCalledExactlyOnceWith(
    '/v1/diagnostics',
    expect.any(AbortSignal),
  )
  expect(snapshot).toMatchObject({
    schemaVersion: 1,
    versions: { desktop: '0.1.0', cli: '0.2.0', engine: '1.2.3' },
    engine: { status: 'available', snapshot: { schemaVersion: 24, queues: { mutations: 2 } } },
    desktop: {
      sync: { phase: 'live', lastSyncAt: 42, healthRefreshFailed: false },
      healthWarnings: ['lowDiskSpace'],
    },
    logs: { available: true },
  })
  expect(snapshot.logs.records).toHaveLength(50)
  expect(snapshot.logs.records[0]).toMatchObject({
    ts: lines[59].ts,
    level: 'warn',
    err: { class: 'Error', message: '[redacted]', stack: [] },
  })
  expect(snapshot.logs.records.at(-1)).toMatchObject({ ts: lines[10].ts })
  for (const canary of Object.values(privateFields)) expect(json).not.toContain(canary)
})

it('keeps local diagnostics when Engine is unreachable and classifies the error', async () => {
  const json = await collect(
    async () => {
      throw new EngineError(0, 'unreachable', privateText)
    },
    async () => privateText,
  )
  expect(JSON.parse(json)).toMatchObject({
    versions: { desktop: '0.1.0', cli: null, engine: null },
    engine: { status: 'unavailable', errorClass: 'EngineError' },
    desktop: { sync: { phase: 'live' } },
    logs: { available: false, records: [] },
  })
  for (const canary of Object.values(privateFields)) expect(json).not.toContain(canary)
})

it.each([
  {
    response: new Response(privateText, { status: 403 }),
    status: 'unauthorized',
    errorClass: 'EngineError',
  },
  {
    response: new Response(privateText, { status: 404 }),
    status: 'unsupported',
    errorClass: 'EngineError',
  },
  { response: new Response(privateText), status: 'invalid', errorClass: 'SyntaxError' },
  { response: Response.json(privateFields), status: 'invalid', errorClass: 'ZodError' },
  {
    response: Response.json({ ...engineSnapshot, padding: privateText.repeat(1024) }),
    status: 'invalid',
    errorClass: 'ZodError',
  },
])(
  'keeps only the Engine status and error class for $status ($errorClass)',
  async ({ response, status, errorClass }) => {
    const json = await collect(async () => response)
    expect(JSON.parse(json).engine).toEqual({ status, errorClass })
  },
)
