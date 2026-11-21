import { execFile, spawn } from 'node:child_process'
import { mkdtemp, rm, writeFile } from 'node:fs/promises'
import { homedir, tmpdir } from 'node:os'
import { join } from 'node:path'
import { createInterface } from 'node:readline'
import { promisify } from 'node:util'
import type { TriageHarness } from './triage.ts'

export const runClaude: TriageHarness = async ({
  url,
  bearer,
  tools,
  prompt,
  schema,
  signal,
  allowReads,
}) => {
  const cwd = await mkdtemp(join(tmpdir(), 'amc-triage-'))
  const home = homedir()
  const command = join(home, '.local', 'bin', 'claude')
  // Match the tested headless profile. An allow-list keeps billing and gateway variables out.
  const env = {
    HOME: home,
    PATH: '/opt/homebrew/bin:/usr/bin:/bin:/usr/sbin:/sbin',
    TMPDIR: '/tmp',
  }
  try {
    const { stdout } = await promisify(execFile)(command, ['auth', 'status', '--json'], {
      cwd,
      env,
      timeout: 10_000,
      signal,
    }).catch(() => {
      signal.throwIfAborted()
      throw new Error(
        'Claude Code must be installed at ~/.local/bin/claude and signed into Claude.ai',
      )
    })
    const auth = JSON.parse(stdout)
    if (auth.authMethod !== 'claude.ai' || auth.apiProvider !== 'firstParty')
      throw new Error('Triage requires a Claude.ai subscription login')

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
      { cwd, env, detached: true, stdio: ['ignore', 'pipe', 'ignore'] },
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
    try {
      let inventoryAccepted = false
      let result: unknown
      const allowed = new Set([...tools, 'StructuredOutput'])
      for await (const line of createInterface({ input: child.stdout })) {
        const event = JSON.parse(line)
        if (event.type === 'system' && event.subtype === 'init') {
          const names: string[] = event.tools
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
        if (event.type === 'result' && event.is_error === false) result = event.structured_output
      }
      const code = await stopped
      signal.throwIfAborted()
      if (code !== 0 || !inventoryAccepted || result === undefined)
        throw new Error('Claude Code did not return triage decisions')
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
