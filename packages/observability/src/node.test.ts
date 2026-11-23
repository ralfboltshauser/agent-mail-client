import { mkdtempSync, readdirSync, readFileSync, rmSync, statSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { afterEach, beforeEach, expect, it, vi } from 'vitest'
import { rotatingFileSink, stackFilePaths, stdoutSink } from './node.ts'

let directory: string
let path: string
let sink: ReturnType<typeof rotatingFileSink> | undefined
beforeEach(() => {
  directory = mkdtempSync(join(tmpdir(), 'amc-log-test-'))
  path = join(directory, 'main.log')
})
afterEach(async () => {
  await sink?.close()
  rmSync(directory, { recursive: true, force: true })
  vi.useRealTimers()
  vi.restoreAllMocks()
})

it('rotates by UTF-8 bytes and keeps the latest generations as private complete lines', async () => {
  sink = rotatingFileSink(path, { maxBytes: 9, maxFiles: 2 })
  sink('"é"')
  sink('"b"')
  sink('"c"')
  // Force another rotation and verify the oldest generation disappeared.
  sink('"dddd"')
  sink('"too large"')
  await sink.close()
  expect(readdirSync(directory).sort()).toEqual(['main.log', 'main.log.1'])
  expect(readFileSync(path, 'utf8')).toBe('"dddd"\n')
  expect(readFileSync(`${path}.1`, 'utf8')).toBe('"c"\n')
  expect(statSync(path).mode & 0o777).toBe(0o600)
  expect(statSync(`${path}.1`).mode & 0o777).toBe(0o600)
})

it('expires old active and rotated files during idle time and on restart', async () => {
  const retentionMs = 14 * 86_400_000
  sink = rotatingFileSink(path, { maxBytes: 4, retentionMs })
  vi.useFakeTimers()
  sink('"a"')
  sink('"b"')
  await vi.waitFor(() => expect(readFileSync(path, 'utf8')).toBe('"b"\n'))
  const age = 15 * 86_400_000
  vi.setSystemTime(Date.now() + age)
  await vi.advanceTimersByTimeAsync(3_600_000)
  await vi.waitFor(() => expect(readdirSync(directory)).toEqual([]))
  sink('"c"')
  await sink.close()

  vi.setSystemTime(Date.now() + age)
  const restarted = rotatingFileSink(path, { retentionMs })
  restarted('"d"')
  await restarted.close()
  expect(readFileSync(path, 'utf8')).toBe('"d"\n')
})

it('bounds queued writes and drains accepted records on close', async () => {
  sink = rotatingFileSink(path)
  for (let index = 0; index < 129; index++) sink(String(index))
  const finished = sink.close()
  sink('"after close"')
  await finished
  const lines = readFileSync(path, 'utf8').trimEnd().split('\n')
  expect(lines).toHaveLength(128)
  expect(lines.at(-1)).toBe('127')
})

it('writes one stdout line at a time and skips records under backpressure', () => {
  const write = vi.spyOn(process.stdout, 'write').mockImplementation(() => true)
  const backpressure = vi.spyOn(process.stdout, 'writableNeedDrain', 'get')
  backpressure.mockReturnValue(false)
  stdoutSink('{"event":"http.request"}')
  backpressure.mockReturnValue(true)
  stdoutSink('{"event":"skip"}')
  expect(write).toHaveBeenCalledExactlyOnceWith('{"event":"http.request"}\n')
})

it('registers the filesystem and URL forms used by Node stacks', () => {
  expect(stackFilePaths([[new URL('file:///synthetic/amc%20app/http.ts'), 'http']])).toEqual(
    new Map([
      ['file:///synthetic/amc%20app/http.ts', 'http'],
      ['/synthetic/amc app/http.ts', 'http'],
    ]),
  )
})
