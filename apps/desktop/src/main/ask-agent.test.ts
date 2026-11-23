import { execFile } from 'node:child_process'
import { mkdir, mkdtemp, readdir, rm, writeFile } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { promisify } from 'node:util'
import { afterEach, beforeEach, expect, it, vi } from 'vitest'
import { askAgent } from './ask-agent'
import { EngineClient } from './engine'
import type { T3Launch } from './handoff'
import { localT3Launcher } from './t3-cli'

let home: string
vi.mock('node:os', async (load) => ({
  ...((await load()) as typeof import('node:os')),
  homedir: () => home,
}))
vi.mock('./t3-cli', () => ({ localT3Launcher: vi.fn() }))

const run = promisify(execFile)
const engine = new EngineClient('https://engine.example.test', 'paired-owner')
const open = vi.fn()
const launch = vi.fn<(request: T3Launch) => Promise<{ threadId: string; link: string }>>()
let profile: string
let workspaceRoot: string

beforeEach(async () => {
  home = await mkdtemp(join(tmpdir(), 'amc-ask-agent-'))
  profile = join(home, 'profile')
  workspaceRoot = join(home, 'repo')
  const skills = join(workspaceRoot, 'apps/cli/skills/use-amc')
  const bin = join(home, '.local/bin')
  await mkdir(skills, { recursive: true })
  await writeFile(join(skills, 'SKILL.md'), '# Synthetic skill')
  await mkdir(bin, { recursive: true })
  await writeFile(
    join(bin, 'amc'),
    '#!/bin/sh\nprintf "%s\\n" "$AMC_ENGINE_URL" "$AMC_TOKEN" "$@"\n',
    { mode: 0o700 },
  )
  open.mockReset().mockResolvedValue(undefined)
  launch
    .mockReset()
    .mockResolvedValue({ threadId: 'new-thread', link: 't3code://threads/env/new-thread' })
  vi.mocked(localT3Launcher).mockResolvedValue({
    key: 'test',
    projects: async () => [{ id: 'amc', title: 'AMC', workspaceRoot }],
    launch,
  })
})

afterEach(async () => {
  vi.restoreAllMocks()
  await rm(home, { recursive: true, force: true })
})

it('launches T3 with a read-only CLI wrapper and omits the bearer from the prompt', async () => {
  const request = vi.spyOn(engine, 'request').mockResolvedValue({ id: 'id', token: "read'grant" })
  const question = 'Find mail from alice@example.test about the meeting'
  expect(await askAgent(engine, profile, question, 'account', () => true, open)).toEqual({
    opened: true,
  })
  expect(request).toHaveBeenCalledExactlyOnceWith(
    '/v1/tokens',
    expect.objectContaining({
      method: 'POST',
      body: { name: 'Ask Agent', scopes: ['read'], expiresInMinutes: 60, accountId: 'account' },
    }),
  )
  const directory = join(profile, 'agent-search')
  const [filename] = await readdir(directory)
  const executable = join(directory, filename ?? '')
  expect(launch).toHaveBeenCalledExactlyOnceWith(
    expect.objectContaining({
      projectId: 'amc',
      message: expect.stringContaining(question),
    }),
  )
  const [call] = launch.mock.calls
  expect(call?.[0].message).toContain(executable)
  expect(call?.[0].message).not.toContain("read'grant")
  expect(open).toHaveBeenCalledExactlyOnceWith('t3code://threads/env/new-thread')
  expect(
    (await run(executable, ['search', '--json', '--', 'from:alice@example.test'])).stdout
      .trim()
      .split('\n'),
  ).toEqual([
    'https://engine.example.test',
    "read'grant",
    '--as-agent',
    'search',
    '--json',
    '--',
    'from:alice@example.test',
  ])
  await expect(run(executable, ['send'])).rejects.toMatchObject({ code: 2 })
})

it('checks the active AMC project before minting a grant', async () => {
  vi.mocked(localT3Launcher).mockResolvedValue({ key: 'test', projects: async () => [], launch })
  const request = vi.spyOn(engine, 'request').mockResolvedValue(undefined)
  expect(await askAgent(engine, profile, 'Question', null, () => true, open)).toMatchObject({
    opened: false,
  })
  expect(request).not.toHaveBeenCalled()
  expect(launch).not.toHaveBeenCalled()
})

it('revokes the unused grant if the Engine changes while preparing the launch', async () => {
  const current = vi.fn().mockReturnValueOnce(true).mockReturnValue(false)
  const request = vi
    .spyOn(engine, 'request')
    .mockResolvedValueOnce({ id: 'id', token: 'read-grant' })
    .mockResolvedValueOnce(undefined)
  expect(await askAgent(engine, profile, 'Question', null, current, open)).toMatchObject({
    opened: false,
  })
  expect(launch).not.toHaveBeenCalled()
  expect(request).toHaveBeenLastCalledWith(
    '/v1/tokens/id',
    expect.objectContaining({ method: 'DELETE' }),
  )
  expect(await readdir(join(profile, 'agent-search'))).toEqual([])
})
