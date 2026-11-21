import { type ExecFileException, execFile, spawn } from 'node:child_process'
import { mkdtemp, rm, writeFile } from 'node:fs/promises'
import { homedir, tmpdir, userInfo } from 'node:os'
import { join } from 'node:path'
import { createInterface } from 'node:readline'
import type { TriageHarness } from './triage.ts'

export class ClaudeAuthError extends Error {}

const RESULT_ERRORS = new Set([
  'error_during_execution',
  'error_max_turns',
  'error_max_budget_usd',
  'error_max_structured_output_retries',
])

type ClaudeEvent = {
  type?: string
  subtype?: string
  tools?: unknown
  is_error?: boolean
  structured_output?: unknown
  error?: { message?: unknown } | string
  message?: unknown
  errors?: unknown
  result?: unknown
}

function errorText(value: unknown): string | undefined {
  return typeof value === 'string' ? value.trim() || undefined : undefined
}

export const runClaude: TriageHarness = async ({
  url,
  bearer,
  tools,
  prompt,
  schema,
  signal,
  allowReads,
}) => {
  const home = homedir()
  const { username } = userInfo()
  const command = join(home, '.local', 'bin', 'claude')
  // Match the tested headless profile. An allow-list keeps billing and gateway variables out.
  const env = {
    HOME: home,
    PATH: '/opt/homebrew/bin:/usr/bin:/bin:/usr/sbin:/sbin',
    TMPDIR: '/tmp',
    USER: username,
    LOGNAME: username,
  }
  const cwd = await mkdtemp(join(tmpdir(), 'amc-triage-'))
  try {
    const { error, stdout } = await new Promise<{
      error: ExecFileException | null
      stdout: string
    }>((resolve) => {
      execFile(
        command,
        ['auth', 'status', '--json'],
        { cwd, env, timeout: 10_000, signal },
        (error, stdout) => resolve({ error, stdout }),
      )
    })
    signal.throwIfAborted()
    if (error?.code === 'ENOENT')
      throw new ClaudeAuthError('Claude Code not found at ~/.local/bin/claude')

    const statusError = 'Could not check Claude Code sign-in status'
    let auth: { loggedIn?: unknown; authMethod?: unknown; apiProvider?: unknown } | null
    try {
      auth = JSON.parse(stdout)
    } catch {
      throw new ClaudeAuthError(statusError)
    }
    if (auth?.loggedIn === false)
      throw new ClaudeAuthError(
        'Claude Code is not signed in: run `claude` and log in with Claude.ai',
      )
    if (error || auth?.loggedIn !== true) throw new ClaudeAuthError(statusError)
    if (auth.authMethod !== 'claude.ai' || auth.apiProvider !== 'firstParty')
      throw new ClaudeAuthError('Triage requires a Claude.ai subscription login')

    const config = join(cwd, 'mcp.json')
    await writeFile(
      config,
      JSON.stringify({
        mcpServers: {
          amc: {
            type: 'http',
            url,
            headers: { Authorization: `Bearer ${bearer}` },
          },
        },
      }),
      { mode: 0o600 },
    )

    signal.throwIfAborted()
    const child = spawn(
      command,
      [
        '-p',
        '--restricted',
        '--setting-sources',
        '',
        '--strict-mcp-config',
        '--mcp-config',
        config,
        '--tools',
        '',
        '--allowedTools',
        ...tools,
        '--permission-mode',
        'dontAsk',
        '--no-session-persistence',
        '--output-format',
        'stream-json',
        '--verbose',
        '--max-turns',
        '25',
        '--json-schema',
        JSON.stringify(schema),
        '--',
        prompt,
      ],
      { cwd, env, detached: true, stdio: ['ignore', 'pipe', 'pipe'] },
    )

    const stopped = new Promise<number | null>((resolve, reject) => {
      child.once('error', reject)
      child.once('close', resolve)
    })
    // Observe spawn errors even if the stdout iterator fails first.
    void stopped.catch(() => {})
    const stop = () => {
      if (child.pid === undefined) return
      try {
        process.kill(-child.pid, 'SIGKILL')
      } catch (error) {
        if ((error as NodeJS.ErrnoException).code !== 'ESRCH') throw error
      }
    }
    signal.addEventListener('abort', stop, { once: true })
    if (signal.aborted) stop()
    let inventoryAccepted = false
    let stderr = ''
    const diagnosticLimit = 2_000
    child.stderr.setEncoding('utf8').on('data', (chunk: string) => {
      if (!inventoryAccepted && stderr.length < diagnosticLimit)
        stderr += chunk.slice(0, diagnosticLimit - stderr.length)
    })
    try {
      let result: unknown
      let startupError: string | undefined
      let resultError: string | undefined
      const allowed = new Set([...tools, 'StructuredOutput'])
      for await (const line of createInterface({ input: child.stdout })) {
        let event: ClaudeEvent | null
        try {
          event = JSON.parse(line)
        } catch {
          // Some CLI failures use plain text instead of stream-json.
          continue
        }
        if (event?.type === 'system' && event.subtype === 'init') {
          const names = event.tools
          if (
            !Array.isArray(names) ||
            names.length !== allowed.size ||
            new Set(names).size !== allowed.size ||
            names.some((name) => !allowed.has(name))
          )
            throw new Error('Claude Code exposed an unexpected tool inventory')
          inventoryAccepted = true
          allowReads()
        }
        if (event?.type === 'error' && !inventoryAccepted)
          startupError =
            errorText(typeof event.error === 'object' ? event.error?.message : event.error) ??
            errorText(event.message)
        if (event?.type === 'result') {
          if (event.is_error === false) result = event.structured_output
          if (event.is_error === true) {
            // Once reads are enabled, free-form errors can echo model or tool input.
            if (!inventoryAccepted)
              startupError =
                (Array.isArray(event.errors)
                  ? event.errors.map(errorText).filter(Boolean).join('; ')
                  : undefined) ||
                errorText(event.result) ||
                startupError
            if (event.subtype && RESULT_ERRORS.has(event.subtype)) resultError = event.subtype
          }
        }
      }
      const code = await stopped
      signal.throwIfAborted()
      if (code !== 0 || !inventoryAccepted || result === undefined) {
        const detail = startupError ?? errorText(stderr) ?? resultError
        if (detail)
          throw new Error(
            `Claude Code triage failed: ${detail.replaceAll(bearer, '[redacted]').slice(0, diagnosticLimit)}`,
          )
        throw new Error('Claude Code did not return triage decisions')
      }
      return result
    } finally {
      signal.removeEventListener('abort', stop)
      if (child.exitCode === null && child.signalCode === null) stop()
      await stopped.catch(() => {})
    }
  } finally {
    await rm(cwd, { recursive: true, force: true })
  }
}
