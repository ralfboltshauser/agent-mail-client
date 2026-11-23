import { access, mkdir, mkdtemp, readFile, rm, writeFile } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { dirname, join } from 'node:path'
import { afterEach, beforeEach, expect, it, vi } from 'vitest'
import { runClaude } from './triage-claude.ts'

const fixture = vi.hoisted(() => ({ home: '' }))
vi.mock('node:os', async (importOriginal) => ({
  ...(await importOriginal<typeof import('node:os')>()),
  homedir: () => fixture.home,
}))

const tools = ['mcp__amc__list_untriaged', 'mcp__amc__get_thread']
const childSource = `
const { readFileSync, writeFileSync } = require('node:fs')
const { join } = require('node:path')
const args = process.argv.slice(2)
if (args.join(' ') === 'auth status --json') {
  console.log(JSON.stringify({ loggedIn: true, authMethod: 'claude.ai', apiProvider: 'firstParty' }))
  process.exit(0)
}
const config = JSON.parse(readFileSync(args[args.indexOf('--mcp-config') + 1], 'utf8'))
if (config.mcpServers.amc.headers.Authorization !== 'Bearer fixture' ||
    config.mcpServers.amc.url !== 'http://localhost/fixture' ||
    !args.includes('--strict-mcp-config') ||
    !args.includes('Synthetic message')) process.exit(2)
const tools = args.slice(args.indexOf('--allowedTools') + 1, args.indexOf('--permission-mode'))
const mode = readFileSync(join(process.env.HOME, 'mode'), 'utf8')
writeFileSync(join(process.env.HOME, 'process.json'), JSON.stringify({ pid: process.pid, cwd: process.cwd() }))
console.log(JSON.stringify({
  type: 'system', subtype: 'init',
  tools: [...tools, 'StructuredOutput', ...(mode === 'unexpected' ? ['Bash'] : [])]
}))
if (mode === 'cancel') setInterval(() => {}, 1000)
else console.log(JSON.stringify({ type: 'result', is_error: false, structured_output: { decisions: [] } }))
`

beforeEach(async () => {
  fixture.home = await mkdtemp(join(tmpdir(), 'amc-claude-fixture-'))
  const command = join(fixture.home, '.local', 'bin', 'claude')
  await mkdir(dirname(command), { recursive: true })
  await writeFile(command, `#!${process.execPath}\n${childSource}`, { mode: 0o700 })
})

afterEach(async () => {
  await rm(fixture.home, { recursive: true, force: true })
})

async function checkCleanup() {
  const { pid, cwd } = JSON.parse(await readFile(join(fixture.home, 'process.json'), 'utf8'))
  await expect(access(cwd)).rejects.toMatchObject({ code: 'ENOENT' })
  expect(() => process.kill(pid, 0)).toThrow(expect.objectContaining({ code: 'ESRCH' }))
}

it.each(['normal', 'unexpected', 'cancel'])(
  'runs the offline triage process (%s)',
  async (mode) => {
    await writeFile(join(fixture.home, 'mode'), mode)
    const controller = new AbortController()
    const cancelled = new Error('Triage deadline reached')
    const allowReads = vi.fn(() => {
      if (mode === 'cancel') controller.abort(cancelled)
    })
    const result = runClaude({
      url: 'http://localhost/fixture',
      bearer: 'fixture',
      tools,
      prompt: 'Synthetic message',
      schema: {},
      signal: controller.signal,
      allowReads,
    })
    if (mode === 'normal') {
      await expect(result).resolves.toEqual({ decisions: [] })
    } else if (mode === 'unexpected') {
      await expect(result).rejects.toMatchObject({ reason: 'agent-tools' })
    } else {
      await expect(result).rejects.toBe(cancelled)
    }
    expect(allowReads).toHaveBeenCalledTimes(mode === 'unexpected' ? 0 : 1)
    await checkCleanup()
  },
)
