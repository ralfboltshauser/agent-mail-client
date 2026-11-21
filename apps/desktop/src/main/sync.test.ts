import { expect, it, vi } from 'vitest'
import type { SyncPhase } from '../shared/api'
import { EngineClient, EngineError } from './engine'
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
