import { mkdtemp, readFile, rm } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { pathToFileURL } from 'node:url'
import { createLogger, isCorrelationId, REQUEST_ID_HEADER } from '@amc/observability'
import type { IpcMainInvokeEvent } from 'electron'
import { afterEach, expect, it, vi } from 'vitest'
import { projectActionFailures } from './action-failures'
import { EngineClient } from './engine'
import { configureDesktopLogs, ipcError } from './observability'
import { limitRendererReports, ownMainFrame } from './renderer-reporting'
import { Replica } from './replica'
import { SyncLoop } from './sync'

const canaries = [
  'SYNTHETIC SUBJECT',
  'SYNTHETIC BODY',
  'synthetic@example.invalid',
  'SYNTHETIC DISPLAY NAME',
  'SYNTHETIC ATTACHMENT.pdf',
  'SYNTHETIC OWNER REASON',
  'SYNTHETIC-TOKEN',
  'https://synthetic.invalid/query',
]

afterEach(() => {
  vi.unstubAllGlobals()
  vi.unstubAllEnvs()
})

it('keeps failures correlated across Engine requests, IPC, and local logs', async () => {
  const path = await mkdtemp(join(tmpdir(), 'amc-desktop-log-test-'))
  vi.stubEnv('AMC_LOG_LEVEL', 'warn')
  const settings = configureDesktopLogs(
    join(path, 'logs'),
    path,
    pathToFileURL(join(path, 'index.js')).href,
  )
  try {
    expect(settings.write(true)).toEqual({ debug: true, effectiveLevel: 'warn' })
    const ids: string[] = []
    vi.stubGlobal('fetch', async (_url: URL, init: RequestInit) => {
      const id = new Headers(init.headers).get(REQUEST_ID_HEADER)
      if (id) ids.push(id)
      return Response.json({ error: 'internal', message: canaries.join(' ') }, { status: 500 })
    })
    const engine = new EngineClient('http://engine.invalid', 'synthetic-grant')
    const error = await engine
      .get('/v1/fixture')
      .catch((cause: unknown) => ipcError('amc:thread', cause))
    expect(ids).toHaveLength(1)
    expect(isCorrelationId(ids[0])).toBe(true)
    const visible = String(error)
    expect(visible).toContain(ids[0])
    expect(visible).toContain('EngineError')
    await settings.close()
    const logs = await readFile(join(path, 'logs', 'main.log'), 'utf8')
    expect(logs).toContain('desktop.http.failed')
    expect(logs).toContain('desktop.ipc.failed')
    expect(
      logs
        .trim()
        .split('\n')
        .map((line) => JSON.parse(line).requestId),
    ).toEqual([ids[0], ids[0]])
    for (const value of canaries) {
      expect(visible).not.toContain(value)
      expect(logs).not.toContain(value)
    }
  } finally {
    await settings.close()
    await rm(path, { recursive: true, force: true })
  }
})

it('logs a health refresh failure class and exposes only the ID and class', async () => {
  const path = await mkdtemp(join(tmpdir(), 'amc-desktop-health-test-'))
  const settings = configureDesktopLogs(
    join(path, 'logs'),
    path,
    pathToFileURL(join(path, 'index.js')).href,
  )
  const engine = new EngineClient('http://engine.invalid', 'synthetic-grant')
  const replica = new Replica(':memory:')
  replica.modseq = 7
  vi.spyOn(engine, 'get').mockImplementation(async (route) => {
    if (route === '/v1/me') return {}
    if (route === '/v1/health') throw new TypeError(canaries.join(' '))
    return { changes: [], modseq: 7, more: false }
  })
  vi.spyOn(engine, 'events').mockImplementation(async (_path, _onEvent, signal) => {
    await new Promise<void>((resolve) =>
      signal.addEventListener('abort', () => resolve(), { once: true }),
    )
  })
  const loop = new SyncLoop(engine, replica)
  try {
    loop.start()
    await vi.waitFor(() => expect(loop.status.healthRefreshFailed).toBe(true))
    const failure = loop.status.healthFailure
    expect(failure).toMatchObject({ errorClass: 'TypeError', kind: 'Run' })
    await settings.close()
    const logs = await readFile(join(path, 'logs', 'main.log'), 'utf8')
    expect(JSON.parse(logs.trim())).toMatchObject({
      event: 'desktop.sync.failed',
      stage: 'health',
      runId: failure?.id,
      err: { class: 'TypeError' },
    })
    for (const value of canaries) expect(logs).not.toContain(value)
  } finally {
    loop.stop()
    replica.db.close()
    await settings.close()
    await rm(path, { recursive: true, force: true })
  }
})

it('projects failed action payloads without exposing provider error text', () => {
  const failure = projectActionFailures('amc:ownerAction', {
    actionId: 'synthetic-action',
    status: 'failed',
    error: canaries.join(' '),
    undo: null,
  })
  const output = JSON.stringify(failure)
  expect(output).toContain('EngineError · Request')
  for (const value of canaries) expect(output).not.toContain(value)
})

it('validates same-window main-frame reports, projects metadata, and bounds flood volume', () => {
  let time = 0
  const lines: string[] = []
  const logger = createLogger({ component: 'renderer', sink: (line) => lines.push(line) })
  const report = limitRendererReports(
    () => logger,
    () => time,
  )
  const url = 'file:///synthetic-app/index.html'
  const mainFrame = { url }
  const event = { sender: { mainFrame }, senderFrame: mainFrame } as unknown as IpcMainInvokeEvent
  expect(ownMainFrame(event, event.sender, url)).toBe(true)
  expect(ownMainFrame(event, event.sender, 'https://synthetic.invalid')).toBe(false)
  const subframe = { ...event, senderFrame: { url } } as IpcMainInvokeEvent
  expect(ownMainFrame(subframe, event.sender, url)).toBe(false)
  report({ source: 'window.error', errorClass: canaries[0] })
  report({ source: 'window.error', errorClass: 'TypeError', requestId: canaries[7] })
  for (let i = 0; i < 50; i++) {
    report({
      source: 'window.error',
      errorClass: 'TypeError',
      message: canaries.join(' '),
      stack: canaries[7],
    })
  }
  expect(lines).toHaveLength(40)
  time = 60_000
  report({ source: 'react.boundary', errorClass: 'RangeError' })
  expect(JSON.parse(lines[40] ?? '')).toMatchObject({
    event: 'renderer.failures.dropped',
    count: 10,
  })
  expect(JSON.parse(lines[41] ?? '')).toMatchObject({
    event: 'renderer.failure',
    source: 'react.boundary',
  })
  for (const value of canaries) expect(lines.join('\n')).not.toContain(value)
})
