import { execFile } from 'node:child_process'
import { homedir } from 'node:os'
import { join } from 'node:path'
import { promisify } from 'node:util'
import { sanitizeError } from '@amc/observability'
import { assembleDiagnostics, type DiagnosticsSource } from '@amc/observability/local-reader'
import { Diagnostics, privateHealthWarnings } from '@amc/protocol'
import type { SyncStatus } from '../shared/api'
import type { EngineClient } from './engine'

const versionPattern = /^(?:dev|\d{1,8}\.\d{1,8}\.\d{1,8})$/
const maxEngineBytes = 64 * 1024

function safeVersion(value: string | null) {
  return value && versionPattern.test(value) ? value : null
}

export async function installedCliVersion(): Promise<string | null> {
  try {
    const { stdout } = await promisify(execFile)(
      join(homedir(), '.local', 'bin', 'amc'),
      ['--version'],
      { timeout: 2_000, killSignal: 'SIGKILL', maxBuffer: 1024 },
    )
    return stdout.trim()
  } catch {
    return null
  }
}

async function readEngineBody(response: Response): Promise<unknown> {
  if (!response.body) return null
  const reader = response.body.getReader()
  const chunks: Uint8Array[] = []
  let bytes = 0
  try {
    for (;;) {
      const { done, value } = await reader.read()
      if (done) return JSON.parse(Buffer.concat(chunks, bytes).toString('utf8'))
      bytes += value.byteLength
      if (bytes > maxEngineBytes) {
        void reader.cancel().catch(() => {})
        return null
      }
      chunks.push(value)
    }
  } finally {
    reader.releaseLock()
  }
}

async function engineDiagnostics(
  engine: Pick<EngineClient, 'authenticatedGet'> | null,
): Promise<DiagnosticsSource<Diagnostics>> {
  if (!engine) return { status: 'unavailable' }
  const signal = AbortSignal.timeout(5_000)
  try {
    const response = await engine.authenticatedGet('/v1/diagnostics', signal)
    if (!response.ok) {
      void response.body?.cancel().catch(() => {})
      const status =
        response.status === 404
          ? 'unsupported'
          : response.status === 401 || response.status === 403
            ? 'unauthorized'
            : 'unavailable'
      return { status, errorClass: 'EngineError' }
    }
    const parsed = Diagnostics.safeParse(await readEngineBody(response))
    if (!parsed.success || Buffer.byteLength(JSON.stringify(parsed.data)) > maxEngineBytes)
      return { status: 'invalid', errorClass: 'ZodError' }
    return { status: 'available', snapshot: parsed.data }
  } catch (error) {
    const { class: errorClass } = sanitizeError(signal.aborted ? signal.reason : error)
    return { status: errorClass === 'SyntaxError' ? 'invalid' : 'unavailable', errorClass }
  }
}

export async function desktopDiagnostics(input: {
  directory: string
  desktopVersion: string
  readCliVersion: () => Promise<string | null>
  engine: Pick<EngineClient, 'authenticatedGet'> | null
  sync: SyncStatus
}): Promise<string> {
  const [engine, cliVersion] = await Promise.all([
    engineDiagnostics(input.engine),
    input.readCliVersion(),
  ])
  const bundle = await assembleDiagnostics({
    directory: input.directory,
    versions: {
      desktop: safeVersion(input.desktopVersion),
      cli: safeVersion(cliVersion),
      engine: engine.status === 'available' ? safeVersion(engine.snapshot.version) : null,
    },
    engine,
  })
  const { sync } = input
  return JSON.stringify({
    ...bundle,
    desktop: {
      sync: {
        phase: sync.phase,
        progress: sync.progress,
        lastSyncAt: sync.lastSyncAt,
        mailCheck: sync.mailCheck ?? null,
        healthRefreshFailed: sync.healthRefreshFailed ?? null,
      },
      healthWarnings: sync.healthWarnings
        ? Object.entries(privateHealthWarnings)
            .filter(([, message]) => sync.healthWarnings?.includes(message))
            .map(([code]) => code)
        : null,
    },
  })
}
