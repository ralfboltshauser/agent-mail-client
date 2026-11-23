import { expect, it, vi } from 'vitest'
import type { SyncPhase } from '../shared/api'
import { EngineClient, EngineError } from './engine'
import { handleMailRefreshKey } from './mail-menu'
import { Replica } from './replica'
import { SyncLoop } from './sync'

it('retries transient Engine failures and parks pairing only after an explicit 401', async () => {
  vi.useFakeTimers()
  const replica = new Replica(':memory:')
  const engine = new EngineClient('https://engine.example', 'fixture')
  const loop = new SyncLoop(engine, replica)
  const request = vi.spyOn(engine, 'get')
  request
    .mockRejectedValueOnce(new EngineError(0, 'unreachable', 'unreachable'))
    .mockRejectedValueOnce(new EngineError(503, 'unavailable', 'unavailable'))
    .mockRejectedValueOnce(new EngineError(401, 'unauthorized', 'unauthorized'))
  const phases: SyncPhase[] = []
  loop.on('status', ({ phase }) => phases.push(phase))
  try {
    loop.start()
    await vi.advanceTimersByTimeAsync(3_000)
    expect(phases).toEqual(['offline', 'error', 'unpaired'])
    await vi.advanceTimersByTimeAsync(30_000)
    expect(request).toHaveBeenCalledTimes(3)
  } finally {
    loop.stop()
    replica.db.close()
    vi.useRealTimers()
  }
})

it('checks the Engine once per burst and pulls no-op results without invalidating the mailbox', async () => {
  vi.useFakeTimers()
  const replica = new Replica(':memory:')
  replica.modseq = 7
  const engine = new EngineClient('https://engine.example', 'fixture')
  const get = vi.spyOn(engine, 'get').mockImplementation(async (path) => {
    if (path === '/v1/me') return {}
    if (path.startsWith('/v1/sync/changes?')) return { changes: [], modseq: 7, more: false }
    throw new Error('Unexpected Engine read')
  })
  vi.spyOn(engine, 'events').mockImplementation(
    (_path, _callback, signal) =>
      new Promise<void>((resolve) =>
        signal.addEventListener('abort', () => resolve(), { once: true }),
      ),
  )
  let finish!: (result: { ok: boolean }) => void
  const request = vi
    .spyOn(engine, 'request')
    .mockReturnValueOnce(
      new Promise((resolve) => {
        finish = resolve
      }),
    )
    .mockResolvedValue({ ok: true })
  const changed = vi.fn()
  const loop = new SyncLoop(engine, replica)
  loop.on('changed', changed)
  try {
    loop.start()
    await vi.advanceTimersByTimeAsync(0)
    get.mockClear()

    const checkMail = vi.fn(() => loop.checkMail())
    const key = {
      type: 'keyDown',
      key: 'r',
      meta: true,
      control: false,
      shift: false,
      alt: false,
      isAutoRepeat: false,
    } as const
    handleMailRefreshKey({ preventDefault: vi.fn() }, key, checkMail)
    expect(checkMail).toHaveBeenCalledOnce()
    const checking = checkMail.mock.results[0].value
    expect(loop.status.mailCheck).toBe('checking')
    await loop.checkMail()
    expect(request).toHaveBeenCalledExactlyOnceWith('/v1/sync/check-mail', {
      method: 'POST',
      signal: expect.any(AbortSignal),
    })
    expect(get).not.toHaveBeenCalled()

    finish({ ok: true })
    await checking
    expect(loop.status.mailCheck).toBeUndefined()
    expect(get).toHaveBeenCalledExactlyOnceWith('/v1/sync/changes?since=7&limit=2000', {
      signal: expect.any(AbortSignal),
    })
    expect(changed).not.toHaveBeenCalled()
    expect(replica.modseq).toBe(7)

    await vi.advanceTimersByTimeAsync(4_999)
    await loop.checkMail()
    expect(request).toHaveBeenCalledTimes(1)
    await vi.advanceTimersByTimeAsync(1)
    request.mockRejectedValueOnce(new Error('Engine unavailable'))
    await loop.checkMail()
    expect(loop.status.mailCheck).toBe('failed')

    await vi.advanceTimersByTimeAsync(5_000)
    await loop.checkMail()
    expect(loop.status.mailCheck).toBeUndefined()
    expect(request).toHaveBeenCalledTimes(3)
    expect(changed).not.toHaveBeenCalled()
  } finally {
    loop.stop()
    await vi.advanceTimersByTimeAsync(0)
    replica.db.close()
    vi.useRealTimers()
  }
})
