import { afterEach, beforeEach, expect, it, vi } from 'vitest'
import { AutoTriage } from './auto-triage'

const minute = 60_000
const arrive = (id: string, account = 'one') => new Map([[id, account]])

function setup(
  run = vi.fn(async (_account: string, _signal: AbortSignal) => ({ assigned: 2, skipped: 1 })),
) {
  const latestSharedRun = vi.fn<() => number | undefined>()
  const onLowBattery = vi.fn(async () => false)
  const triage = new AutoTriage({
    enabled: true,
    lastRun: null,
    latestSharedRun,
    onLowBattery,
    accountForRun: (account, pending) =>
      account ?? (pending ? pending.values().next().value : 'one'),
    saveLastRun: vi.fn(),
    changed: vi.fn(),
  })
  triage.connect(run)
  triage.setAvailable(true)
  return { triage, run, latestSharedRun, onLowBattery }
}

beforeEach(() => {
  vi.useFakeTimers()
  vi.setSystemTime(new Date('2026-11-21T12:00:00Z'))
})

afterEach(() => vi.useRealTimers())

it('debounces from the last arrival and enforces a global cooldown, including manual runs', async () => {
  const { triage, run } = setup()
  triage.arrivals(arrive('a'))
  await vi.advanceTimersByTimeAsync(minute)
  triage.arrivals(arrive('b'))
  await vi.advanceTimersByTimeAsync(2 * minute - 1)
  expect(run).not.toHaveBeenCalled()
  await vi.advanceTimersByTimeAsync(1)
  expect(run).toHaveBeenCalledOnce()
  expect(triage.status.lastRun).toEqual({
    at: Date.now(),
    result: { assigned: 2, skipped: 1 },
    error: null,
  })

  triage.arrivals(arrive('c', 'two'))
  await triage.now('two')
  await vi.advanceTimersByTimeAsync(10 * minute - 1)
  expect(run).toHaveBeenCalledOnce()
  await vi.advanceTimersByTimeAsync(1)
  expect(run).toHaveBeenCalledTimes(2)
  expect(run.mock.calls[1]?.[0]).toBe('two')
})

it('waits for an interrupted run to finish before allowing another run', async () => {
  let finish!: () => void
  const gate = new Promise<void>((resolve) => {
    finish = resolve
  })
  const run = vi.fn(async (_account: string, _signal: AbortSignal) => {
    await gate
    throw new Error('Some private mail content')
  })
  const { triage } = setup(run)
  const firstRun = triage.now('one')
  await vi.advanceTimersByTimeAsync(0)
  expect(run).toHaveBeenCalledOnce()
  expect(triage.status.running).toBe(true)
  await triage.now('two')
  triage.setAvailable(false)
  expect(run.mock.calls[0]?.[1].aborted).toBe(true)
  triage.setAvailable(true)
  await vi.advanceTimersByTimeAsync(10 * minute)
  await triage.now('two')
  expect(run).toHaveBeenCalledOnce()
  finish()
  await firstRun
  expect(triage.status.lastRun?.error).toBe('Triage was interrupted.')
  await triage.now('two')
  expect(run).toHaveBeenCalledTimes(2)
  expect(triage.status.lastRun?.error).toBe('Triage failed.')
})

it('keeps pending arrivals during Pause Sync and allows manual runs when auto-triage is off', async () => {
  const { triage, run } = setup()
  triage.arrivals(arrive('a'))
  triage.setAvailable(false)
  await vi.advanceTimersByTimeAsync(3 * minute)
  await triage.now('one')
  expect(run).not.toHaveBeenCalled()
  triage.setAvailable(true)
  await vi.advanceTimersByTimeAsync(0)
  expect(run).toHaveBeenCalledOnce()

  triage.setEnabled(false)
  triage.arrivals(arrive('b'))
  await vi.advanceTimersByTimeAsync(10 * minute)
  expect(run).toHaveBeenCalledOnce()
  await triage.now(null)
  expect(run).toHaveBeenCalledTimes(2)
})

it('skips recent Host triage and low battery, then resumes pending work', async () => {
  const { triage, run, latestSharedRun, onLowBattery } = setup()
  latestSharedRun.mockReturnValue(Date.now())
  onLowBattery.mockResolvedValue(true)
  triage.arrivals(arrive('a'))
  await vi.advanceTimersByTimeAsync(2 * minute)
  expect(triage.status.notice).toMatch(/last 10 minutes/)
  await vi.advanceTimersByTimeAsync(8 * minute)
  expect(triage.status.notice).toMatch(/below 20%/)
  expect(run).not.toHaveBeenCalled()
  onLowBattery.mockResolvedValue(false)
  await vi.advanceTimersByTimeAsync(10 * minute)
  expect(run).toHaveBeenCalledOnce()
})
