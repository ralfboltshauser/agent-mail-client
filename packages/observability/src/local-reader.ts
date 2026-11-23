import { constants } from 'node:fs'
import { open } from 'node:fs/promises'
import { join } from 'node:path'
import { projectStoredError } from './errors.ts'
import { type EventName, events } from './events.ts'
import { isCorrelationId } from './ids.ts'
import { type Component, components, type Level, levels, safeScope, validField } from './index.ts'

export interface LogQuery {
  component?: Component
  since?: number
  level?: Level
  runId?: string
  requestId?: string
}

interface LogRecord {
  ts: string
  level: Level
  component: Component
  event: EventName
  runId?: string
  requestId?: string
  [key: string]: unknown
}

const maxLineBytes = 16 * 1024
const dayMs = 86_400_000
export const recentLogWindowMs = dayMs

export function projectLogLine(line: string): LogRecord | undefined {
  if (Buffer.byteLength(line) > maxLineBytes) return
  try {
    const value = JSON.parse(line)
    if (!value || typeof value !== 'object' || Array.isArray(value)) return
    if (value.schemaVersion !== undefined && value.schemaVersion !== 1) return
    const { ts, level, component, event } = value
    if (typeof ts !== 'string' || ts.length !== 24 || new Date(ts).toISOString() !== ts) return
    if (!levels.includes(level) || !components.includes(component)) return
    if (typeof event !== 'string' || !Object.hasOwn(events, event)) return
    const spec = events[event as EventName]
    const fields: Record<string, unknown> = {}
    for (const [key, rule] of Object.entries(spec.fields)) {
      const field = value[key]
      if (rule === 'error') {
        const error = projectStoredError(field)
        if (error) fields[key] = error
      } else if (rule === 'route') {
        // The reader has no trusted Hono registration table. Use the catalog's
        // fallback so a forged route cannot turn into a persisted URL or path.
        fields[key] = 'unmatched'
      } else {
        if (!validField(rule, field)) return
        fields[key] = field
      }
    }
    return {
      ts,
      level,
      component,
      event: event as EventName,
      ...safeScope(value),
      ...(isCorrelationId(value.spanId) ? { spanId: value.spanId } : {}),
      ...(isCorrelationId(value.parentSpanId) ? { parentSpanId: value.parentSpanId } : {}),
      ...fields,
      ...('message' in spec ? { msg: spec.message(fields) } : {}),
    }
  } catch {
    // Corrupt lines and timestamps must never become diagnostic output.
  }
}

export function matchesLogQuery(record: LogRecord, query: LogQuery): boolean {
  return (
    (!query.component || record.component === query.component) &&
    (query.since === undefined || Date.parse(record.ts) >= query.since) &&
    (!query.level || levels.indexOf(record.level) >= levels.indexOf(query.level)) &&
    (!query.runId || record.runId === query.runId) &&
    (!query.requestId || record.requestId === query.requestId)
  )
}

async function readTail(path: string, maxBytes: number) {
  const handle = await open(path, constants.O_RDONLY | constants.O_NOFOLLOW | constants.O_NONBLOCK)
  try {
    const stat = await handle.stat()
    if (!stat.isFile()) return
    const length = Math.min(stat.size, maxBytes)
    const position = stat.size - length
    const buffer = Buffer.alloc(length)
    const { bytesRead } = await handle.read(buffer, 0, length, position)
    const text = buffer.toString('utf8', 0, bytesRead)
    const lines = text.split('\n')
    // The first line could begin in the middle of a larger record. The last
    // segment has no newline and may be an append still in progress.
    if (position > 0) lines.shift()
    lines.pop()
    return lines
  } finally {
    await handle.close()
  }
}

interface ReadOptions {
  maxRecords?: number
  maxBytes?: number
  scanBytesPerFile?: number
  now?: number
}

export async function readLocalLogs(
  directory: string,
  query: LogQuery = {},
  {
    maxRecords = 5_000,
    maxBytes = 2 * 1024 * 1024,
    scanBytesPerFile = 10 * 1024 * 1024,
    now = Date.now(),
  }: ReadOptions = {},
) {
  const records: LogRecord[] = []
  let available = false
  const seen = new Set<string>()
  for (const component of query.component ? [query.component] : components) {
    for (let generation = 0; generation < 5; generation++) {
      const suffix = generation === 0 ? '' : `.${generation}`
      let lines: string[] | undefined
      try {
        lines = await readTail(join(directory, `${component}.log${suffix}`), scanBytesPerFile)
      } catch {
        // Rotation may remove a sibling between reads. Other readable files still count.
        continue
      }
      if (!lines) continue
      available = true
      let remaining = maxRecords
      for (let index = lines.length - 1; index >= 0 && remaining > 0; index--) {
        const line = lines[index]
        if (line === undefined) continue
        const record = projectLogLine(line)
        if (
          !record ||
          Date.parse(record.ts) > now ||
          record.component !== component ||
          !matchesLogQuery(record, query)
        )
          continue
        // A rotation during the scan can expose the same line in two siblings.
        const key = JSON.stringify(record)
        if (seen.has(key)) continue
        seen.add(key)
        records.push(record)
        remaining--
      }
    }
  }

  records.sort((a, b) => b.ts.localeCompare(a.ts))
  let size = 0
  let count = 0
  while (count < Math.min(records.length, maxRecords)) {
    size += Buffer.byteLength(JSON.stringify(records[count])) + 1
    if (size > maxBytes) break
    count++
  }
  return { available, records: records.slice(0, count) }
}

export async function readRecentLogs(directory: string, now = Date.now()) {
  const limits = { now, scanBytesPerFile: 512 * 1024 }
  const since = now - recentLogWindowMs
  const [warnings, recent] = await Promise.all([
    readLocalLogs(
      directory,
      { since, level: 'warn' },
      { ...limits, maxRecords: 50, maxBytes: 32_768 },
    ),
    readLocalLogs(directory, { since }, { ...limits, maxRecords: 100, maxBytes: 32_768 }),
  ])
  const ids = (key: 'runId' | 'requestId') =>
    [...new Set(recent.records.flatMap((record) => record[key] ?? []))].slice(0, 20)
  return { ...warnings, runIds: ids('runId'), requestIds: ids('requestId') }
}

export type DiagnosticsSource<T> =
  | { status: 'available'; snapshot: T }
  | { status: 'unavailable' | 'unsupported' | 'unauthorized' | 'invalid' }

/** Supply the Engine snapshot only after running the dedicated protocol validator. */
export async function assembleDiagnostics<T>(input: {
  directory: string
  versions: Readonly<Record<string, string>>
  engine: DiagnosticsSource<T>
}) {
  return {
    schemaVersion: 1,
    versions: input.versions,
    engine: input.engine,
    logs: await readRecentLogs(input.directory),
  }
}
