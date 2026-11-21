import { execFile } from 'node:child_process'
import { existsSync } from 'node:fs'
import { mkdtemp, rm } from 'node:fs/promises'
import { homedir, tmpdir, userInfo } from 'node:os'
import { join } from 'node:path'
import { promisify } from 'node:util'
import { expect, it } from 'vitest'
import { ModelDecisions, triageJsonSchema } from './triage.ts'

const claude = join(homedir(), '.local', 'bin', 'claude')
const run = promisify(execFile)

// Local only. Opt in with AMC_TEST_CLAUDE=1 pnpm exec vitest run apps/cli/src/triage-claude.local.test.ts.
it.skipIf(process.env.CI || process.env.AMC_TEST_CLAUDE !== '1' || !existsSync(claude))(
  'accepts the triage JSON Schema in installed Claude Code with a synthetic prompt',
  async () => {
    const cwd = await mkdtemp(join(tmpdir(), 'amc-claude-test-'))
    try {
      const { username } = userInfo()
      const options = {
        cwd,
        env: {
          HOME: homedir(),
          PATH: '/opt/homebrew/bin:/usr/bin:/bin:/usr/sbin:/sbin',
          TMPDIR: '/tmp',
          USER: username,
          LOGNAME: username,
        },
        timeout: 45_000,
      }
      const { stdout: auth } = await run(claude, ['auth', 'status', '--json'], options)
      expect(JSON.parse(auth)).toMatchObject({
        loggedIn: true,
        authMethod: 'claude.ai',
        apiProvider: 'firstParty',
      })
      const fixture = { decisions: [{ threadId: 'example', bucket: 'Update', reason: 'Fixture' }] }
      const { stdout } = await run(
        claude,
        [
          '-p',
          '--restricted',
          '--setting-sources',
          '',
          '--strict-mcp-config',
          '--tools',
          '',
          '--no-session-persistence',
          '--output-format',
          'json',
          '--json-schema',
          JSON.stringify(triageJsonSchema),
          '--',
          `Return this exact synthetic decision as structured output: ${JSON.stringify(fixture)}`,
        ],
        options,
      )
      const result = JSON.parse(stdout)
      expect(result.is_error).toBe(false)
      expect(ModelDecisions.parse(result.structured_output)).toEqual(fixture)
      expect(result.structured_output).toEqual(fixture)
    } finally {
      await rm(cwd, { recursive: true, force: true })
    }
  },
  60_000,
)
