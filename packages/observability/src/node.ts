import { constants } from 'node:fs'
import { chmod, lstat, mkdir, open, rename, unlink } from 'node:fs/promises'
import { homedir } from 'node:os'
import { dirname, isAbsolute, join } from 'node:path'
import { setTimeout as wait } from 'node:timers/promises'
import { fileURLToPath } from 'node:url'
import type { OwnStackFiles } from './errors.ts'
import type { Sink } from './index.ts'

export const macLogDirectory = () => join(homedir(), 'Library', 'Logs', 'AMC')

export function cliLogDirectory() {
  if (process.platform === 'darwin') return macLogDirectory()
  const state = process.env.XDG_STATE_HOME
  return join(
    state && isAbsolute(state) ? state : join(homedir(), '.local', 'state'),
    'amc',
    'logs',
  )
}

const activeFileSinks = new Map<string, Sink>()
export const activeFileSink = (path: string): Sink | undefined => activeFileSinks.get(path)

const pendingFileLocks = new Map<string, Promise<void>>()

async function coordinateFile(path: string, task: () => Promise<void>) {
  const previous = pendingFileLocks.get(path) ?? Promise.resolve()
  const current = previous.catch(() => {}).then(() => withFileLock(path, task))
  pendingFileLocks.set(path, current)
  try {
    await current
  } finally {
    if (pendingFileLocks.get(path) === current) pendingFileLocks.delete(path)
  }
}

async function withFileLock(path: string, task: () => Promise<void>) {
  const lockPath = `${path}.lock`
  const flags = constants.O_CREAT | constants.O_RDWR | constants.O_NOFOLLOW | constants.O_NONBLOCK
  const lock = await open(lockPath, flags, 0o600)
  try {
    if (!(await lock.stat()).isFile()) return
    await lock.chmod(0o600)
  } finally {
    await lock.close()
  }
  // A SQLite RESERVED lock is an OS advisory lock. SQLite releases it even if
  // the owning process dies. This empty coordination file stores no records.
  const { DatabaseSync } = await import('node:sqlite')
  const db = new DatabaseSync(lockPath)
  try {
    for (let attempt = 0; ; attempt++) {
      try {
        db.exec('BEGIN IMMEDIATE')
        break
      } catch (error) {
        if ((error as { errcode?: number }).errcode !== 5 || attempt === 20) throw error
        await wait(25)
      }
    }
    try {
      await task()
    } finally {
      db.exec('ROLLBACK')
    }
  } finally {
    db.close()
  }
}

export function stackFilePaths(entries: ReadonlyArray<readonly [URL, string]>): OwnStackFiles {
  const files = new Map<string, string>()
  for (const [url, label] of entries) {
    files.set(url.href, label)
    files.set(fileURLToPath(url), label)
  }
  return files
}

let watchingStdout = false
export const stdoutSink: Sink = (line) => {
  const stdout = process.stdout
  if (!watchingStdout) {
    // Stream errors may arrive after write() returns.
    stdout.on('error', () => {})
    watchingStdout = true
  }
  if (stdout.writable && !stdout.writableNeedDrain) stdout.write(`${line}\n`)
}

const dayMs = 24 * 60 * 60 * 1000

interface RotationOptions {
  maxBytes?: number
  maxFiles?: number
  retentionMs?: number
  coordinate?: boolean
}

/** One writer per file. Maintenance and writes share a bounded asynchronous queue. */
export function rotatingFileSink(
  path: string,
  {
    maxBytes = 10 * 1024 * 1024,
    maxFiles = 5,
    retentionMs = 14 * dayMs,
    coordinate = false,
  }: RotationOptions = {},
): Sink & { close(): Promise<void> } {
  if (![maxBytes, maxFiles, retentionMs].every((value) => Number.isSafeInteger(value) && value > 0))
    throw new RangeError('Invalid AMC log rotation options')

  const file = (generation: number) => (generation === 0 ? path : `${path}.${generation}`)
  const pruneInterval = Math.min(retentionMs, 60 * 60 * 1000)
  let maintenance: ReturnType<typeof setInterval> | undefined
  let nextPrune = 0
  let tail = Promise.resolve()
  let pending = 0
  let pendingBytes = 0
  let closed = false

  function enqueue(task: () => Promise<void>, bytes = 0) {
    if (closed || pending >= 128 || pendingBytes + bytes > Math.max(maxBytes, 256 * 1024)) return
    pending++
    pendingBytes += bytes
    tail = tail
      .then(async () => {
        if (!coordinate) return task()
        const directory = dirname(path)
        await mkdir(directory, { recursive: true, mode: 0o700 })
        if (!(await lstat(directory)).isDirectory()) return
        await chmod(directory, 0o700)
        await coordinateFile(path, task)
      })
      .catch(() => {
        // A failed write or prune must not prevent subsequent attempts.
        nextPrune = 0
      })
      .finally(() => {
        pending--
        pendingBytes -= bytes
      })
  }

  async function fileStats(name: string) {
    try {
      const stat = await lstat(name)
      if (!stat.isFile()) throw new Error('AMC log path is not a regular file')
      return stat
    } catch (error) {
      if ((error as NodeJS.ErrnoException).code !== 'ENOENT') throw error
    }
  }

  async function prune(now: number) {
    for (let index = 0; index < maxFiles; index++) {
      const name = file(index)
      const stat = await fileStats(name)
      if (stat && now - (stat.birthtimeMs || stat.mtimeMs) >= retentionMs) await unlink(name)
    }
    nextPrune = now + pruneInterval
  }

  async function append(record: string, bytes: number) {
    const now = Date.now()
    if (now >= nextPrune) {
      await mkdir(dirname(path), { recursive: true, mode: 0o700 })
      await prune(now)
    }
    const active = await fileStats(path)
    if (active && active.size + bytes > maxBytes) {
      const oldest = file(maxFiles - 1)
      if (await fileStats(oldest)) await unlink(oldest)
      for (let index = maxFiles - 2; index >= 0; index--) {
        const from = file(index)
        if (await fileStats(from)) await rename(from, file(index + 1))
      }
    }
    const handle = await open(
      path,
      constants.O_WRONLY |
        constants.O_CREAT |
        constants.O_APPEND |
        constants.O_NOFOLLOW |
        constants.O_NONBLOCK,
      0o600,
    )
    try {
      if (!(await handle.stat()).isFile()) return
      await handle.chmod(0o600)
      await handle.writeFile(record)
    } finally {
      await handle.close()
    }
  }

  const write: Sink = (line) => {
    if (closed) return
    const bytes = Buffer.byteLength(line) + 1
    if (bytes > maxBytes) return
    enqueue(() => append(`${line}\n`, bytes), bytes)
    maintenance ??= setInterval(() => enqueue(() => prune(Date.now())), pruneInterval).unref()
  }

  activeFileSinks.set(path, write)
  return Object.assign(write, {
    close: () => {
      closed = true
      if (activeFileSinks.get(path) === write) activeFileSinks.delete(path)
      clearInterval(maintenance)
      return tail
    },
  })
}
