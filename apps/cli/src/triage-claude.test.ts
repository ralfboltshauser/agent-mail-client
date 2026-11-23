import { EventEmitter } from 'node:events'
import { homedir, userInfo } from 'node:os'
import { PassThrough } from 'node:stream'
import { afterEach, expect, it, vi } from 'vitest'
import { runClaude } from './triage-claude.ts'

const { execFile, spawn } = vi.hoisted(() => ({ execFile: vi.fn(), spawn: vi.fn() }))
vi.mock('node:child_process', () => ({ execFile, spawn }))

afterEach(() => {
  vi.resetAllMocks()
  vi.unstubAllEnvs()
})

function run() {
  return runClaude({
    url: 'http://localhost',
    bearer: 'fixture',
    tools: [],
    prompt: '',
    schema: {},
    signal: new AbortController().signal,
    allowReads: vi.fn(),
  })
}

function authResult(stdout: string, error: Error | null = null) {
  execFile.mockImplementation((_command, _args, _options, callback) => callback(error, stdout, ''))
}

it('passes only the allowed environment to Claude auth and the triage run', async () => {
  vi.stubEnv('ANTHROPIC_API_KEY', 'fixture')
  vi.stubEnv('ANTHROPIC_AUTH_TOKEN', 'fixture')
  vi.stubEnv('ANTHROPIC_BASE_URL', 'https://gateway.invalid')
  vi.stubEnv('CLAUDE_CODE_USE_BEDROCK', '1')
  vi.stubEnv('USER', 'wrong-user')
  vi.stubEnv('LOGNAME', 'wrong-login-name')
  authResult('{"loggedIn":true,"authMethod":"claude.ai","apiProvider":"firstParty"}')

  const stopBeforeRun = new Error('Stop at spawn')
  spawn.mockImplementation(() => {
    throw stopBeforeRun
  })

  await expect(run()).rejects.toBe(stopBeforeRun)
  const env = {
    HOME: homedir(),
    PATH: '/opt/homebrew/bin:/usr/bin:/bin:/usr/sbin:/sbin',
    TMPDIR: '/tmp',
    USER: userInfo().username,
    LOGNAME: userInfo().username,
  }
  expect(execFile).toHaveBeenCalledWith(
    `${homedir()}/.local/bin/claude`,
    ['auth', 'status', '--json'],
    expect.objectContaining({ env }),
    expect.any(Function),
  )
  expect(spawn).toHaveBeenCalledWith(
    `${homedir()}/.local/bin/claude`,
    expect.any(Array),
    expect.objectContaining({ env }),
  )
})

it.each([
  {
    stdout: '',
    code: 'ENOENT',
    message: 'Claude Code was not found at ~/.local/bin/claude',
  },
  {
    stdout: '{"loggedIn":false,"authMethod":"none","apiProvider":"firstParty"}',
    code: 1,
    message: 'Sign in to Claude Code with a Claude.ai subscription',
  },
  {
    stdout: '',
    code: 'EACCES',
    message: 'Could not check Claude Code sign-in',
  },
  {
    stdout: '{"loggedIn":true,"authMethod":"claude.ai","apiProvider":"firstParty"}',
    code: 1,
    message: 'Could not check Claude Code sign-in',
  },
  {
    stdout: 'invalid JSON',
    code: undefined,
    message: 'Could not check Claude Code sign-in',
  },
  {
    stdout: '{"loggedIn":true,"authMethod":"apiKey","apiProvider":"firstParty"}',
    code: undefined,
    message: 'Sign in to Claude Code with a Claude.ai subscription',
  },
])(
  'reports $message when Claude auth returns $code and $stdout',
  async ({ stdout, code, message }) => {
    authResult(
      stdout,
      code === undefined ? null : Object.assign(new Error('Auth failed'), { code }),
    )
    await expect(run()).rejects.toThrow(message)
    expect(spawn).not.toHaveBeenCalled()
  },
)

function failedRun(events: object[], stderr: string) {
  authResult('{"loggedIn":true,"authMethod":"claude.ai","apiProvider":"firstParty"}')
  spawn.mockImplementation(() => {
    const stdout = new PassThrough()
    const stderrStream = new PassThrough()
    const child = Object.assign(new EventEmitter(), { stdout, stderr: stderrStream, exitCode: 1 })
    setImmediate(() => {
      stdout.end(events.map((event) => JSON.stringify(event)).join('\n'))
      stderrStream.end(stderr)
      child.emit('close', 1)
    })
    return child
  })
}

it('classifies startup errors without echoing CLI diagnostics', async () => {
  const canary = 'sensitive-value'
  failedRun([{ type: 'error', error: { message: canary } }], canary)
  await expect(run()).rejects.toMatchObject({
    reason: 'agent-start',
    message: expect.not.stringContaining(canary),
  })
})

it('reports a known failure subtype without echoing model or tool data', async () => {
  failedRun(
    [
      { type: 'system', subtype: 'init', tools: ['StructuredOutput'] },
      {
        type: 'result',
        subtype: 'error_max_structured_output_retries',
        is_error: true,
        errors: ['Private fixture text'],
      },
    ],
    '',
  )
  await expect(run()).rejects.toMatchObject({ reason: 'agent-output' })
})
