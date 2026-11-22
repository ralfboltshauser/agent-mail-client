import { mkdtempSync, rmSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { expect, it, vi } from 'vitest'
import { createQuitHandler, QUIT_DRAIN_MS } from './quit'
import { Replica } from './replica'

it('exits at the deadline when quit work stalls and replays the staged draft on restart', async () => {
  vi.useFakeTimers()
  const dir = mkdtempSync(join(tmpdir(), 'amc-quit-'))
  const path = join(dir, 'replica.db')
  const patch = { baseRevision: 3, update: 'AAA=' }
  const replica = new Replica(path)
  let finishRequest: () => void = () => {}
  const stalledRequest = new Promise<void>((resolve) => {
    finishRequest = resolve
  })
  const engine = { request: vi.fn().mockReturnValue(stalledRequest) }
  const drain = vi.fn(() => replica.draftUpdates.flush(engine))
  const exit = vi.fn()
  const beforeQuit = createQuitHandler(drain, exit)
  const event = { preventDefault: vi.fn() }

  try {
    replica.draftUpdates.stage('draft', patch)
    beforeQuit(event)
    await vi.advanceTimersByTimeAsync(QUIT_DRAIN_MS - 1)
    beforeQuit(event)
    expect(event.preventDefault).toHaveBeenCalledTimes(2)
    expect(drain).toHaveBeenCalledTimes(1)
    expect(engine.request).toHaveBeenCalledTimes(1)
    expect(exit).not.toHaveBeenCalled()

    await vi.advanceTimersByTimeAsync(1)
    expect(exit).toHaveBeenCalledTimes(1)

    const reopened = new Replica(path)
    try {
      const request = vi.fn().mockResolvedValue(undefined)
      await reopened.draftUpdates.flush({ request })
      expect(request).toHaveBeenCalledExactlyOnceWith(
        '/v1/compose/drafts/draft',
        expect.objectContaining({ body: patch }),
      )
    } finally {
      reopened.db.close()
    }

    finishRequest()
    await vi.advanceTimersByTimeAsync(0)
    expect(exit).toHaveBeenCalledTimes(1)
  } finally {
    replica.db.close()
    vi.useRealTimers()
    rmSync(dir, { recursive: true, force: true })
  }
})

it('exits when cleanup settles and cancels the deadline', async () => {
  vi.useFakeTimers()
  try {
    const exit = vi.fn()
    const event = { preventDefault: vi.fn() }
    const drain = vi.fn().mockRejectedValue(new Error('Cleanup failed'))

    createQuitHandler(drain, exit)(event)
    await vi.advanceTimersByTimeAsync(0)

    expect(event.preventDefault).toHaveBeenCalledOnce()
    expect(exit).toHaveBeenCalledOnce()
    expect(vi.getTimerCount()).toBe(0)
  } finally {
    vi.useRealTimers()
  }
})
