import { mkdtemp, rm, symlink, writeFile } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { afterEach, beforeEach, expect, it } from 'vitest'
import { newRequestId, newRunId } from './ids.ts'
import {
  assembleDiagnostics,
  projectLogLine,
  readLocalLogs,
  readRecentLogs,
} from './local-reader.ts'

const now = Date.parse('2026-11-23T12:00:00Z')
const requestId = newRequestId()
const runId = newRunId()
const canaries = [
  'synthetic subject',
  'synthetic mail body',
  'synthetic-name@example.test',
  'Synthetic Display Name',
  'synthetic-attachment.pdf',
  'synthetic owner reason',
  'Bearer test_canary_secret',
  'https://synthetic.example.test/private?q=canary',
]
const secret = canaries.join(' ')
let directory: string

beforeEach(async () => {
  directory = await mkdtemp(join(tmpdir(), 'amc-reader-'))
})
afterEach(async () => {
  await rm(directory, { recursive: true, force: true })
})

function http(at: number, extra: Record<string, unknown> = {}) {
  return {
    ts: new Date(at).toISOString(),
    event: 'http.request',
    level: 'warn',
    component: 'engine',
    status: 404,
    method: 'GET',
    route: 'unmatched',
    durationMs: 12,
    ...extra,
  }
}

function lines(...records: unknown[]) {
  return `${records.map((record) => JSON.stringify(record)).join('\n')}\n`
}

it('projects known fields and rejects malformed and unknown schemas across generations', async () => {
  await writeFile(join(directory, 'engine.log.1'), lines(http(now - 5_000, { runId, requestId })))
  await writeFile(join(directory, 'engine.log.2'), lines(http(now - 2 * 86_400_000)))
  await writeFile(join(directory, 'startup.log'), lines(http(now, { requestId })))
  await writeFile(
    join(directory, 'engine.log'),
    [
      `{ malicious ${secret}`,
      JSON.stringify({ time: now, message: secret }),
      JSON.stringify(http(now, { schemaVersion: 2, requestId, body: secret })),
      JSON.stringify(http(now, { method: secret })),
      JSON.stringify(
        http(now, {
          route: canaries.at(-1),
          msg: secret,
          body: secret,
          requestId,
          runId: secret,
          accountId: secret,
          err: { class: 'Error', code: secret, message: secret, stack: [{ file: secret }] },
        }),
      ),
      '',
    ].join('\n'),
  )
  await symlink(join(directory, 'engine.log'), join(directory, 'engine.log.3'))

  const result = await readLocalLogs(
    directory,
    { component: 'engine', since: now - 6_000, level: 'warn', requestId },
    { now },
  )
  expect(result.available).toBe(true)
  expect(result.records).toHaveLength(2)
  expect(result.records[0]).toEqual({
    ...http(now),
    requestId,
    err: { class: 'Error', message: '[redacted]', stack: [] },
  })
  expect(result.records[1]).toMatchObject({ runId, requestId })
  expect((await readLocalLogs(directory, { runId }, { now })).records).toHaveLength(1)
  expect((await readLocalLogs(directory, { level: 'error' }, { now })).records).toHaveLength(0)
  for (const canary of canaries) expect(JSON.stringify(result)).not.toContain(canary)
})

it('reports unavailable files and returns bounded recent warnings and correlation IDs', async () => {
  expect(await readRecentLogs(directory, now)).toEqual({
    available: false,
    records: [],
    runIds: [],
    requestIds: [],
  })
  const record = (index: number) => http(now - index, { requestId, runId, durationMs: index })
  await writeFile(
    join(directory, 'engine.log'),
    lines(...Array.from({ length: 90 }, (_, i) => record(89 - i))),
  )
  const recent = await readRecentLogs(directory, now)
  expect(recent.records).toHaveLength(50)
  expect(recent.records[0]).toMatchObject({ durationMs: 0 })
  expect(recent.runIds).toEqual([runId])
  expect(recent.requestIds).toEqual([requestId])
  const tiny = await readLocalLogs(directory, {}, { now, maxBytes: 5 })
  expect(tiny).toEqual({ available: true, records: [] })
  const snapshot = await assembleDiagnostics({
    directory,
    versions: { desktop: '1.0.0' },
    engine: { status: 'unavailable' },
  })
  expect(snapshot).toMatchObject({ schemaVersion: 1, engine: { status: 'unavailable' } })
  expect(projectLogLine(JSON.stringify(http(now, { ts: secret })))).toBeUndefined()
})
