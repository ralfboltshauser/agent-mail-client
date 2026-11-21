import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { DatabaseSync } from 'node:sqlite'
import { afterEach, expect, it, vi } from 'vitest'
import { handoffRequest } from './handoff'
import { cliLauncher, detectT3Cli } from './t3-cli'

const home = mkdtempSync(join(tmpdir(), 'amc-t3-cli-'))
afterEach(() => rmSync(home, { recursive: true, force: true }))

it('skips a stale CLI and detects the bundled CLI in the desktop profile', async () => {
  const oldHome = join(home, '.t3')
  const baseDir = join(home, '.local', 'share', 't3code-personal-mac')
  const executable = join(baseDir, 'bin', 't3')
  for (const dir of [oldHome, baseDir]) {
    mkdirSync(join(dir, 'bin'), { recursive: true })
    mkdirSync(join(dir, 'userdata'))
    writeFileSync(join(dir, 'userdata', 'statev2.sqlite'), '')
    writeFileSync(join(dir, 'bin', 't3'), '#!/bin/sh\n', { mode: 0o700 })
  }
  const run = vi
    .fn()
    .mockResolvedValueOnce('Old t3 help')
    .mockResolvedValueOnce('t3 thread start [flags] <project> <message>\n--json')

  await expect(detectT3Cli(home, '', run)).resolves.toEqual({ executable, baseDir })
  expect(run.mock.calls).toEqual([
    [join(oldHome, 'bin', 't3'), ['thread', 'start', '--help']],
    [executable, ['thread', 'start', '--help']],
  ])
})

it('falls back to Connect when no local CLI supports thread start', async () => {
  await expect(detectT3Cli(home, '', vi.fn())).resolves.toBeNull()
})

it('passes the grant and link over stdin and recovers a lost launch response', async () => {
  const baseDir = join(home, 'T3 test profile')
  const state = join(baseDir, 'userdata')
  const executable = join(baseDir, 'bin', 't3')
  mkdirSync(state, { recursive: true })
  writeFileSync(join(state, 'environment-id'), 'local-env\n')
  {
    using db = new DatabaseSync(join(state, 'statev2.sqlite'))
    db.exec(`
      CREATE TABLE projection_projects (
        project_id TEXT, title TEXT, workspace_root TEXT, deleted_at TEXT, archived_at TEXT
      );
      INSERT INTO projection_projects VALUES
        ('active', 'Scratch', '/tmp/scratch', NULL, NULL),
        ('deleted', 'Deleted', '/tmp/deleted', 'today', NULL),
        ('archived', 'Archived', '/tmp/archived', NULL, 'today'),
        ('scratch', 'No project', '', NULL, NULL);
    `)
  }

  const request = handoffRequest(
    'active',
    'request-id',
    'mail-thread',
    'draft-id',
    'https://example.test/compose/draft-id#token=synthetic',
    'https://example.test/mcp',
    'synthetic-grant',
  )
  const title = 'Draft an AMC reply · request-id'
  const run = vi
    .fn()
    .mockResolvedValueOnce('[]')
    .mockRejectedValueOnce(new Error('lost response with synthetic-grant'))
    .mockResolvedValueOnce(JSON.stringify([{ threadId: 'mcp:created', title }]))
  const launcher = cliLauncher({ executable, baseDir }, run)

  await expect(launcher.projects()).resolves.toEqual([{ id: 'active', title: 'Scratch' }])
  const launched = { threadId: 'mcp:created', link: 't3code://threads/local-env/mcp%3Acreated' }
  await expect(launcher.launch(request)).rejects.toThrow('T3 could not confirm the launch.')
  await expect(launcher.launch(request)).resolves.toEqual(launched)

  const flags = ['--base-dir', baseDir, '--json']
  const list = ['thread', 'list', ...flags, '--project', 'active']
  expect(run.mock.calls).toEqual([
    [executable, list],
    [
      executable,
      ['thread', 'start', ...flags, '--title', title, '--', 'active', '-'],
      request.message,
    ],
    [executable, list],
  ])
})
