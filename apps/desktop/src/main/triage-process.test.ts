import { EventEmitter, once } from 'node:events'
import { afterEach, expect, it, vi } from 'vitest'
import { onLowBattery, runTriageProcess } from './triage-process'

const { fork, isOnBatteryPower, execFile } = vi.hoisted(() => ({
  fork: vi.fn(),
  isOnBatteryPower: vi.fn(),
  execFile: vi.fn(),
}))
vi.mock('electron', () => ({ utilityProcess: { fork }, powerMonitor: { isOnBatteryPower } }))
vi.mock('node:child_process', () => ({ execFile }))

afterEach(() => {
  vi.unstubAllGlobals()
  vi.resetAllMocks()
  vi.useRealTimers()
})

it.each(['crash', 'timeout', 'quit'])('revokes the named grant after worker %s', async (exit) => {
  vi.useFakeTimers()
  const child = Object.assign(new EventEmitter(), {
    postMessage: vi.fn(),
    kill: () => child.emit('exit', 1),
  })
  fork.mockImplementation(() => {
    setTimeout(() => child.emit('spawn'), 0)
    return child
  })
  const spawned = once(child, 'spawn')
  const calls: string[] = []
  let holder: string | undefined
  vi.stubGlobal('fetch', async (url: URL, init: RequestInit) => {
    const call = `${init.method} ${url.pathname}`
    calls.push(call)
    const body = init.body ? JSON.parse(String(init.body)) : undefined
    expect(new Headers(init.headers).get('Authorization')).toBe('Bearer owner')
    switch (call) {
      case 'POST /v1/triage/lease':
        holder = body.holder
        return Response.json({ granted: true })
      case 'POST /v1/tokens':
        expect(body.name).toBe(holder)
        return Response.json({ id: 'ours', token: 'scoped' })
      case 'GET /v1/tokens':
        return Response.json({
          tokens: [
            { id: 'other', name: 'triage-other', kind: 'agent', revoked_at: null },
            { id: 'ours', name: holder, kind: 'agent', revoked_at: null },
          ],
        })
      case 'DELETE /v1/tokens/ours':
        return Response.json({ revoked: 'ours' })
      case 'DELETE /v1/triage/lease':
        expect(body.holder).toBe(holder)
        return new Response(null, { status: 204 })
      default:
        throw new Error(call)
    }
  })
  const quit = new AbortController()
  const result = runTriageProcess(
    { engineUrl: 'http://engine.invalid', token: 'owner' },
    'account',
    true,
    new AbortController().signal,
    quit.signal,
  )
  const stopped = expect(result).rejects.toThrow('stopped before returning a result')
  await vi.advanceTimersByTimeAsync(0)
  await spawned
  expect(child.postMessage).toHaveBeenCalledWith({
    engineUrl: 'http://engine.invalid',
    token: 'scoped',
    recent: true,
  })
  if (exit === 'crash') child.emit('exit', 1)
  if (exit === 'timeout') await vi.advanceTimersByTimeAsync(180_000)
  if (exit === 'quit') quit.abort()
  await stopped
  expect(calls).toEqual([
    'POST /v1/triage/lease',
    'POST /v1/tokens',
    'GET /v1/tokens',
    'DELETE /v1/tokens/ours',
    'DELETE /v1/triage/lease',
  ])
})

it('defers triage on battery when pmset fails or returns no percentage', async () => {
  const platform = Object.getOwnPropertyDescriptor(process, 'platform')
  Object.defineProperty(process, 'platform', { value: 'darwin', configurable: true })
  try {
    isOnBatteryPower.mockReturnValue(true)
    execFile.mockImplementationOnce((_command, _args, _options, callback) =>
      callback(new Error('timeout'), ''),
    )
    execFile.mockImplementationOnce((_command, _args, _options, callback) =>
      callback(null, 'Now drawing from Battery Power'),
    )
    execFile.mockImplementationOnce((_command, _args, _options, callback) =>
      callback(null, '80%; discharging'),
    )
    await expect(onLowBattery()).resolves.toBe(true)
    await expect(onLowBattery()).resolves.toBe(true)
    await expect(onLowBattery()).resolves.toBe(false)
  } finally {
    if (platform) Object.defineProperty(process, 'platform', platform)
  }
})
