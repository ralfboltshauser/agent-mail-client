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
afterEach(() => {
  sink?.close()
  rmSync(directory, { recursive: true, force: true })
  vi.useRealTimers()
  vi.restoreAllMocks()
})

it('rotates by UTF-8 bytes and keeps the latest generations as private complete lines', () => {
  sink = rotatingFileSink(path, { maxBytes: 9, maxFiles: 2 })
  sink('"é"')
  sink('"b"')
  sink('"c"')
  expect(readFileSync(`${path}.1`, 'utf8')).toBe('"é"\n"b"\n')
  // Force another rotation and verify the oldest generation disappeared.
  sink('"dddd"')
  sink('"too large"')
  expect(readdirSync(directory).sort()).toEqual(['main.log', 'main.log.1'])
  expect(readFileSync(path, 'utf8')).toBe('"dddd"\n')
  expect(readFileSync(`${path}.1`, 'utf8')).toBe('"c"\n')
  expect(statSync(path).mode & 0o777).toBe(0o600)
  expect(statSync(`${path}.1`).mode & 0o777).toBe(0o600)
})

it('expires old active and rotated files during idle time and on restart', () => {
  sink = rotatingFileSink(path, { maxBytes: 4, retentionMs: 14 * 86_400_000 })
  vi.useFakeTimers()
  sink('"a"')
  sink('"b"')
  const age = 15 * 86_400_000
  vi.setSystemTime(Date.now() + age)
  vi.advanceTimersByTime(3_600_000)
  expect(readdirSync(directory)).toEqual([])
  sink('"c"')
  sink.close()
  const restarted = rotatingFileSink(path, { retentionMs: 14 * 86_400_000 })
  try {
    restarted('"d"')
    expect(readFileSync(path, 'utf8')).toBe('"d"\n')
  } finally {
    restarted.close()
  }
})

it('writes each stdout record as one line', () => {
  const write = vi.spyOn(process.stdout, 'write').mockImplementation(() => true)
  stdoutSink('{"event":"http.request"}')
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
