import { Hono } from 'hono'
import { describe, expect, expectTypeOf, it, vi } from 'vitest'
import { engineEvents } from './engine-events.ts'
import type { EventName } from './events.ts'
import { type RequestLogEnv, requestLogging } from './hono.ts'
import {
  createLogger,
  type EventFields,
  fetchWithRequestId,
  isCorrelationId,
  newRequestId,
  newRunId,
  REQUEST_ID_HEADER,
  type RendererLogReport,
  resolveLogLevel,
  sanitizeError,
  sanitizeErrorMessage,
} from './index.ts'

const canaries = [
  'canary@example.invalid',
  'canary-subject-7f3a',
  'canary-token-7f3a-01234567890123456789',
  'Canary body 9f13',
  'Canary Display Name',
  'canary-invoice-9f13.pdf',
  'Canary owner reason 9f13',
  'https://canary.example.invalid/a?proof=9f13',
]
const secret = canaries.join(' ')
const sourceFile = '/synthetic/amc/src/http.ts'
const stackFiles = new Map([[sourceFile, 'http']])

function maliciousError() {
  const err = new TypeError(secret)
  Object.assign(err, {
    name: secret,
    code: secret,
    cause: { secret },
    stack: `Error: ${secret}\n    at ${secret} (${sourceFile}:2:9)\n    at foreign (/synthetic/${canaries[1]}.ts:11:2)`,
  })
  return err
}

function expectPrivate(output: string) {
  for (const canary of canaries) expect(output).not.toContain(canary)
}

describe('structured logger', () => {
  it('projects all Engine events with provider and request canaries present', () => {
    const lines: string[] = []
    const log = createLogger({
      component: 'engine',
      level: 'debug',
      routes: new Set(['/v1/diagnostics']),
      sink: (line) => lines.push(line),
      stackFiles,
    })
    for (const [event, spec] of Object.entries(engineEvents)) {
      const fields = Object.fromEntries(
        Object.entries(spec.fields).map(([field, rule]) => [
          field,
          typeof rule !== 'string'
            ? rule[0]
            : rule === 'route'
              ? '/v1/diagnostics'
              : rule === 'error'
                ? maliciousError()
                : rule === 'status'
                  ? 500
                  : rule === 'boolean'
                    ? true
                    : 1,
        ]),
      )
      log.log(
        'error',
        event as EventName,
        {
          ...fields,
          subject: secret,
          body: secret,
          ownerReason: secret,
          authorization: secret,
          displayName: secret,
          attachmentName: secret,
          sender: secret,
          recipient: secret,
          url: secret,
        } as never,
        { accountId: secret, requestId: newRequestId() },
      )
    }
    expect(lines.map((line) => JSON.parse(line).event)).toEqual(Object.keys(engineEvents))
    expectPrivate(lines.join('\n'))
  })

  it('allows declared metadata and drops mail canaries through each logger entry point', async () => {
    const lines: string[] = []
    const log = createLogger({
      component: 'main',
      sink: (line) => lines.push(line),
      routes: new Set(['/threads/:id']),
      stackFiles,
    })
    const badFields = {
      subject: secret,
      body: secret,
      msg: secret,
      sender: secret,
      token: secret,
      attachmentName: secret,
      displayName: secret,
      ownerReason: secret,
      authorization: secret,
      url: secret,
      toJSON: () => secret,
    }
    const badScope = { requestId: secret, runId: secret, accountId: secret, token: secret } as never
    const requestId = newRequestId()
    const runId = newRunId()
    const scoped = log.with(badScope).with({ requestId, runId, accountId: 'acc_0123456789ab' })
    scoped.log('info', 'desktop.startup.pairing', { stage: 'reading', ...badFields }, badScope)
    scoped.log('info', 'desktop.sync.phase', { phase: 'live', ...badFields })
    scoped.log('warn', 'feedback.launch.failed', { stage: 'LaunchFailed', ...badFields })
    scoped.log('info', 'desktop.sync.phase', { phase: secret } as never)
    scoped.log('info', secret as never, {} as never)
    scoped.log(secret as never, 'desktop.sync.phase', { phase: 'live' })
    scoped.log('error', 'http.request', {
      method: 'GET',
      route: '/threads/:id',
      status: 500,
      durationMs: 2,
      err: maliciousError(),
      ...badFields,
    })
    scoped.log('error', 'http.request', {
      method: 'GET',
      route: `/threads/${secret}?token=${secret}`,
      status: 500,
      durationMs: 2,
    })
    const report = {
      source: 'window.error',
      errorClass: 'TypeError',
      ...badFields,
    } satisfies RendererLogReport & typeof badFields
    createLogger({ component: 'renderer', sink: (line) => lines.push(line) }).log(
      'error',
      'renderer.failure',
      report,
      badScope,
    )
    scoped.log('error', 'renderer.failure', { source: secret, errorClass: 'Error' } as never)
    scoped.log('error', 'renderer.failure', { source: 'window.error', errorClass: secret } as never)
    const thrown = maliciousError()
    await expect(
      scoped.span('triage.run', () => {
        throw thrown
      }),
    ).rejects.toBe(thrown)
    await expect(
      scoped.span('sync.cycle', async () => {
        throw secret
      }),
    ).rejects.toBe(secret)
    expect(await scoped.span('handoff', () => secret)).toBe(secret)
    expect(await scoped.span(secret as never, () => 1)).toBe(1)

    expect(lines).toHaveLength(11)
    expectPrivate(lines.join('\n'))
    const entries = lines.map((line) => JSON.parse(line))
    expect(entries[1]).toMatchObject({
      requestId,
      runId,
      accountId: 'acc_0123456789ab',
      msg: 'Engine sync phase: live',
    })
    expect(entries[3]).toMatchObject({
      err: {
        class: 'TypeError',
        message: '[redacted]',
        stack: [{ file: 'http', line: 2, column: 9 }],
      },
    })
    expect(entries[6]).toMatchObject({
      level: 'error',
      event: 'span.finished',
      outcome: 'error',
      runId,
    })
    expect(entries[8]).toMatchObject({ err: { class: 'NonError', message: '[redacted]' } })
  })

  it('preserves parent IDs and emits distinct timed spans', async () => {
    const lines: string[] = []
    const log = createLogger({ component: 'engine', sink: (line) => lines.push(line) })
    await log.span('sync.cycle', (run) => run.span('sync.imap.action', () => 42))
    const [parent, child, childEnd, parentEnd] = lines.map((line) => JSON.parse(line))
    expect(isCorrelationId(parent.runId)).toBe(true)
    expect(isCorrelationId(child.spanId)).toBe(true)
    expect(child.spanId).not.toBe(parent.spanId)
    expect(child).toMatchObject({ runId: parent.runId, parentSpanId: parent.spanId })
    expect(childEnd).toMatchObject({
      spanId: child.spanId,
      outcome: 'ok',
      durationMs: expect.any(Number),
    })
    expect(parentEnd).toMatchObject({ spanId: parent.spanId, outcome: 'ok' })
  })

  it('defaults to info and keeps an operation running when its sink fails', async () => {
    const sink = vi.fn(() => {
      throw new Error(secret)
    })
    const log = createLogger({ component: 'cli', sink })
    log.log('debug', 'span.started', { operation: 'handoff' })
    expect(sink).not.toHaveBeenCalled()
    expect(await log.span('handoff', () => 42)).toBe(42)
    expect(sink).toHaveBeenCalledTimes(2)
    expect(resolveLogLevel('debug')).toBe('debug')
    expect(resolveLogLevel(secret)).toBe('info')
    expectTypeOf<EventFields<'desktop.sync.phase'>['phase']>().not.toEqualTypeOf<string>()
  })
})

describe('error sanitization', () => {
  it.each([
    ...canaries,
    `"${canaries[1]}"`,
    `'${canaries[1]}'`,
    `Bearer ${canaries[2]}`,
    `Basic ${canaries[2]}`,
    `access_token=${canaries[2]}`,
    'x'.repeat(400),
    `fetch failed${' '.repeat(280)}${secret}`,
    { message: secret },
  ])('redacts unrecognized error text %#', (input) => {
    expect(sanitizeErrorMessage(input)).toBe('[redacted]')
  })

  it('keeps recognized runtime facts and discards arbitrary stack, causes and codes', () => {
    const error = Object.assign(new Error('fetch failed'), {
      code: 'ECONNRESET',
      cause: maliciousError(),
      stack: `Error: fetch failed\n    at ${sourceFile}:3:9`,
    })
    expect(sanitizeError(error, stackFiles)).toEqual({
      class: 'Error',
      code: 'ECONNRESET',
      message: 'fetch failed',
      stack: [{ file: 'http', line: 3, column: 9 }],
    })
    expect(sanitizeError(maliciousError())).toEqual({
      class: 'TypeError',
      message: '[redacted]',
      stack: [],
    })
    expect(
      sanitizeError(
        Object.defineProperty(new Error(), 'message', {
          get() {
            throw new Error(secret)
          },
        }),
      ),
    ).toEqual({ class: 'UnknownError', message: '[redacted]', stack: [] })
  })
})

describe('request correlation', () => {
  it('preserves request options and discards the incoming request header in the client hook', async () => {
    const source = new Request('https://engine.example.invalid/v1/health', {
      method: 'POST',
      body: secret,
      headers: { Authorization: `Bearer ${canaries[2]}`, [REQUEST_ID_HEADER]: secret },
    })
    const fetcher = vi.fn<typeof fetch>().mockResolvedValue(new Response(null))
    const requestId = newRequestId()
    await fetchWithRequestId(source, { redirect: 'manual' }, requestId, fetcher)
    expect(fetcher).toHaveBeenCalledWith(source, {
      redirect: 'manual',
      headers: expect.any(Headers),
    })
    const headers = new Headers(fetcher.mock.calls[0]?.[1]?.headers)
    expect(headers.get(REQUEST_ID_HEADER)).toBe(requestId)
    expect(headers.get('authorization')).toBe(source.headers.get('authorization'))
  })

  it('echoes valid IDs, replaces invalid IDs and logs registered templates and sanitized failures', async () => {
    const lines: string[] = []
    const app = new Hono<RequestLogEnv>()
    const routes = new Set(['unmatched'])
    app.use(
      '*',
      requestLogging(
        createLogger({ component: 'engine', sink: (line) => lines.push(line), routes }),
      ),
    )
    app.get('/item/:id', (c) => c.text(c.get('requestId')))
    app.get('/failure', () => {
      throw maliciousError()
    })
    app.onError((_error, c) => c.text('failed', 500))
    for (const route of app.routes) routes.add(route.path)
    const requestId = newRequestId()
    const ok = await app.request(`/item/${canaries[0]}?secret=${canaries[1]}`, {
      headers: { [REQUEST_ID_HEADER]: requestId, Authorization: `Bearer ${canaries[2]}` },
    })
    expect(await ok.text()).toBe(requestId)
    expect(ok.headers.get(REQUEST_ID_HEADER)).toBe(requestId)
    const fail = await app.request('/failure', { headers: { [REQUEST_ID_HEADER]: secret } })
    const replacement = fail.headers.get(REQUEST_ID_HEADER)
    expect(isCorrelationId(replacement)).toBe(true)
    expect(fail.status).toBe(500)
    expect((await app.request(`/missing/${canaries[1]}`)).status).toBe(404)
    expectPrivate(lines.join('\n'))
    expect(lines.map((line) => JSON.parse(line))).toEqual([
      expect.objectContaining({
        event: 'http.request',
        status: 200,
        route: '/item/:id',
        requestId,
      }),
      expect.objectContaining({
        level: 'error',
        status: 500,
        route: '/failure',
        requestId: replacement,
        err: { class: 'TypeError', message: '[redacted]', stack: [] },
      }),
      expect.objectContaining({ level: 'warn', status: 404, route: 'unmatched' }),
    ])
  })
})
