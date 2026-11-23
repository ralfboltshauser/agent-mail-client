import {
  closeSync,
  constants,
  fchmodSync,
  mkdirSync,
  openSync,
  renameSync,
  statSync,
  unlinkSync,
  writeFileSync,
} from 'node:fs'
import { homedir } from 'node:os'
import { dirname, join } from 'node:path'
import { fileURLToPath } from 'node:url'
import type { OwnStackFiles } from './errors.ts'
import type { Sink } from './index.ts'

export const macLogDirectory = () => join(homedir(), 'Library', 'Logs', 'AMC')

export function stackFilePaths(entries: ReadonlyArray<readonly [URL, string]>): OwnStackFiles {
  const files = new Map<string, string>()
  for (const [url, label] of entries) {
    files.set(url.href, label)
    files.set(fileURLToPath(url), label)
  }
  return files
}

export const stdoutSink: Sink = (line) => {
  process.stdout.write(`${line}\n`)
}

const dayMs = 24 * 60 * 60 * 1000

interface RotationOptions {
  maxBytes?: number
  maxFiles?: number
  retentionMs?: number
}

/** One writer per file. Maintenance also runs when the process is idle. */
export function rotatingFileSink(
  path: string,
  { maxBytes = 10 * 1024 * 1024, maxFiles = 5, retentionMs = 14 * dayMs }: RotationOptions = {},
): Sink & { close(): void } {
  if (![maxBytes, maxFiles, retentionMs].every((value) => Number.isSafeInteger(value) && value > 0))
    throw new RangeError('Invalid AMC log rotation options')

  const file = (generation: number) => (generation === 0 ? path : `${path}.${generation}`)
  let maintenance: ReturnType<typeof setInterval> | undefined
  let nextPrune = 0

  function prune(now: number) {
    for (let index = 0; index < maxFiles; index++) {
      const name = file(index)
      const stat = statSync(name, { throwIfNoEntry: false })
      if (stat && now - (stat.birthtimeMs || stat.mtimeMs) >= retentionMs) unlinkSync(name)
    }
    nextPrune = now + Math.min(retentionMs, 60 * 60 * 1000)
  }

  const write: Sink = (line) => {
    const record = `${line}\n`
    const bytes = Buffer.byteLength(record)
    if (bytes > maxBytes) return
    const now = Date.now()
    if (now >= nextPrune) {
      mkdirSync(dirname(path), { recursive: true, mode: 0o700 })
      prune(now)
    }
    const active = statSync(path, { throwIfNoEntry: false })
    if (active && active.size + bytes > maxBytes) {
      const oldest = file(maxFiles - 1)
      if (statSync(oldest, { throwIfNoEntry: false })) unlinkSync(oldest)
      for (let index = maxFiles - 2; index >= 0; index--) {
        const from = file(index)
        if (statSync(from, { throwIfNoEntry: false })) renameSync(from, file(index + 1))
      }
    }
    const fd = openSync(
      path,
      constants.O_WRONLY | constants.O_CREAT | constants.O_APPEND | constants.O_NOFOLLOW,
      0o600,
    )
    try {
      fchmodSync(fd, 0o600)
      writeFileSync(fd, record)
    } finally {
      closeSync(fd)
    }
    maintenance ??= setInterval(
      () => {
        try {
          prune(Date.now())
        } catch {
          // Leave the next write able to retry cleanup.
          nextPrune = 0
        }
      },
      Math.min(retentionMs, 60 * 60 * 1000),
    ).unref()
  }

  return Object.assign(write, {
    close: () => {
      clearInterval(maintenance)
      maintenance = undefined
    },
  })
}
