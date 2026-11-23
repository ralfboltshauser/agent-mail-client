import { type ExecFileException, execFile, spawn } from 'node:child_process'
import { mkdtemp, rm, writeFile } from 'node:fs/promises'
import { homedir, tmpdir, userInfo } from 'node:os'
import { join } from 'node:path'
import { createInterface } from 'node:readline'
import { cliFailure } from './observability.ts'
import type { TriageHarness } from './triage.ts'
import { TriageFailure, type TriageFailureReason } from './triage-errors.ts'

export class ClaudeAuthError extends TriageFailure {
  constructor(
    reason: Extract<TriageFailureReason, 'agent-auth' | 'agent-auth-check' | 'agent-missing'>,
  ) {
    super(reason)
    this.name = 'ClaudeAuthError'
  }
}

type ClaudeEvent = {
  type?: string
  subtype?: string
  tools?: unknown
  model?: unknown
  is_error?: boolean
  structured_output?: unknown
}

export const runClaude: TriageHarness = async ({
  url,
  bearer,
  tools,
  prompt,
  schema,
  signal,
  allowReads,
  onModel,
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
    if (error?.code === 'ENOENT') throw new ClaudeAuthError('agent-missing')

    let auth: { loggedIn?: unknown; authMethod?: unknown; apiProvider?: unknown } | null
    try {
      auth = JSON.parse(stdout)
    } catch (parseError) {
      cliFailure('harness-auth', parseError)
      throw new ClaudeAuthError('agent-auth-check')
    }
    if (auth?.loggedIn === false) throw new ClaudeAuthError('agent-auth')
    if (error || auth?.loggedIn !== true) throw new ClaudeAuthError('agent-auth-check')
    if (auth.authMethod !== 'claude.ai' || auth.apiProvider !== 'firstParty')
      throw new ClaudeAuthError('agent-auth')

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
    let malformedOutput = false
    child.stderr.resume()
    try {
      let result: unknown
      let resultFailed = false
      let outputFailed = false
      const allowed = new Set([...tools, 'StructuredOutput'])
      for await (const line of createInterface({ input: child.stdout })) {
        let event: ClaudeEvent | null
        try {
          event = JSON.parse(line)
        } catch (error) {
          // Some CLI failures use plain text instead of stream-json.
          if (!malformedOutput) cliFailure('harness-output', error)
          malformedOutput = true
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
            throw new TriageFailure('agent-tools')
          if (typeof event.model === 'string') onModel?.(event.model)
          inventoryAccepted = true
          allowReads()
        }
        if (event?.type === 'result') {
          if (event.is_error === false) result = event.structured_output
          if (event.is_error === true) resultFailed = true
          outputFailed = event.subtype === 'error_max_structured_output_retries'
        }
      }
      const code = await stopped
      signal.throwIfAborted()
      if (!inventoryAccepted) throw new TriageFailure('agent-start')
      if (outputFailed || (!resultFailed && code === 0 && result === undefined))
        throw new TriageFailure('agent-output')
      if (resultFailed || code !== 0) throw new TriageFailure('agent-run')
      return result
    } catch (error) {
      if (signal.aborted || error instanceof TriageFailure) throw error
      const reason =
        (error as NodeJS.ErrnoException).code === 'ENOENT' ? 'agent-missing' : 'agent-run'
      throw new TriageFailure(reason, { cause: error })
    } finally {
      signal.removeEventListener('abort', stop)
      if (child.exitCode === null && child.signalCode === null) stop()
      await stopped.catch(() => {})
    }
  } finally {
    await rm(cwd, { recursive: true, force: true }).catch((error: unknown) => {
      cliFailure('harness-cleanup', error)
      throw error
    })
  }
}
