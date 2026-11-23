import { execFile } from 'node:child_process'
import { promisify } from 'node:util'
import { components, isCorrelationId, levels } from '@amc/observability'
import {
  type LogQuery,
  matchesLogQuery,
  projectLogLine,
  readLocalLogs,
} from '@amc/observability/local-reader'
import { cliLogDirectory } from '@amc/observability/node'
import * as protocol from '@amc/protocol'
import type { Command } from 'commander'
import { EngineError, request } from './client.ts'
import type { CliConfig } from './config.ts'
import { cliFailure } from './observability.ts'

function parseSince(value: string): number {
  const relative = /^(\d{1,6})([smhd])$/.exec(value)
  const [_, amount, unit] = relative ?? []
  const unitMs = { s: 1000, m: 60_000, h: 3_600_000, d: 86_400_000 } as const
  const timestamp =
    amount && unit
      ? Date.now() - Number(amount) * unitMs[unit as keyof typeof unitMs]
      : /^\d{4}-\d{2}-\d{2}(?:T\d{2}:\d{2}.*)?$/.test(value)
        ? Date.parse(value)
        : NaN
  if (!Number.isFinite(timestamp))
    throw new Error('Use a duration like 2h or an ISO date for --since.')
  return timestamp
}

async function journalLogs(query: LogQuery) {
  try {
    const { stdout } = await promisify(execFile)(
      '/usr/bin/journalctl',
      ['--unit=amc-engine.service', '--output=json', '--lines=5000', '--no-pager', '--quiet'],
      { maxBuffer: 16 * 1024 * 1024, timeout: 4_000 },
    )
    const records = stdout.split('\n').flatMap((line) => {
      try {
        const message: unknown = JSON.parse(line).MESSAGE
        if (typeof message !== 'string') return []
        const record = projectLogLine(message)
        return record &&
          (record.component === 'engine' || record.component === 'mcp') &&
          matchesLogQuery(record, query)
          ? [record]
          : []
      } catch {
        return []
      }
    })
    return { available: true, records }
  } catch {
    return { available: false, records: [] }
  }
}

// The diagnostics contract is published by the Engine slice. Older AMC
// builds have no validator and must never print a raw response.
function engineSnapshot(data: unknown) {
  const schema: unknown = Reflect.get(protocol, 'Diagnostics')
  if (
    typeof schema !== 'object' ||
    schema === null ||
    !('safeParse' in schema) ||
    typeof schema.safeParse !== 'function'
  )
    return
  const parsed = schema.safeParse(data)
  if (parsed.success) return parsed.data as unknown
}

async function printDiagnostics(config: CliConfig | null) {
  const unavailable = (message: string, error: unknown = new Error(message)) => {
    const details = cliFailure('command', error, 'unavailable')
    console.error(`${message} Details: ${details.class} · ${details.id}`)
  }
  if (!config) {
    unavailable('Engine diagnostics unavailable. Pair AMC with an owner token first.')
    return
  }
  try {
    const data = await request<unknown>(config.engineUrl, '/v1/diagnostics', {
      token: config.token,
      redirect: 'error',
      signal: AbortSignal.timeout(5_000),
    })
    const snapshot = engineSnapshot(data)
    if (snapshot === undefined) {
      unavailable('Engine diagnostics unavailable. This AMC CLI could not validate the snapshot.')
      return
    }
    console.log(JSON.stringify(snapshot, null, 2))
  } catch (error) {
    if (error instanceof EngineError && error.status === 404) {
      unavailable('Engine diagnostics are unavailable on this Engine version.', error)
    } else if (error instanceof EngineError && (error.status === 401 || error.status === 403)) {
      unavailable('Engine diagnostics require an owner token.', error)
    } else {
      unavailable('Engine diagnostics unavailable. The Engine could not return a snapshot.', error)
    }
  }
}

export function registerDiagnosticsCommands(program: Command, readConfig: () => CliConfig | null) {
  program
    .command('diagnostics')
    .description('Show the Engine owner diagnostics snapshot')
    .action(() => printDiagnostics(readConfig()))

  program
    .command('logs')
    .description('Read sanitized structured logs from this machine')
    .option('--component <name>', 'engine, main, renderer, cli or mcp')
    .option('--since <time>', 'relative duration such as 2h or an ISO timestamp')
    .option('--level <name>', 'minimum level: debug, info, warn or error')
    .option('--run <id>', 'match the exact run ID')
    .option('--request <id>', 'match the exact request ID')
    .action(
      async (options: {
        component?: string
        since?: string
        level?: string
        run?: string
        request?: string
      }) => {
        const component = components.find((name) => name === options.component)
        const level = levels.find((name) => name === options.level)
        if (options.component !== undefined && !component) throw new Error('Unknown log component.')
        if (options.level !== undefined && !level) throw new Error('Unknown log level.')
        if (options.run !== undefined && !isCorrelationId(options.run))
          throw new Error('Use a UUID v4 for --run.')
        if (options.request !== undefined && !isCorrelationId(options.request))
          throw new Error('Use a UUID v4 for --request.')
        const query = {
          component,
          since: options.since === undefined ? undefined : parseSince(options.since),
          level,
          runId: options.run,
          requestId: options.request,
        }
        const [local, journal] = await Promise.all([
          readLocalLogs(cliLogDirectory(), query),
          process.platform === 'linux' &&
          (!component || component === 'engine' || component === 'mcp')
            ? journalLogs(query)
            : { available: false, records: [] },
        ])
        const records = [...local.records, ...journal.records].sort((a, b) =>
          a.ts.localeCompare(b.ts),
        )
        for (const record of records) console.log(JSON.stringify(record))
        if (!records.length)
          console.error(
            local.available || journal.available
              ? 'No matching AMC log records.'
              : 'No local AMC logs are available.',
          )
      },
    )
}
