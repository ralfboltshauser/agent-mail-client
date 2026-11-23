import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { DatabaseSync } from 'node:sqlite'
import { afterEach, expect, it, vi } from 'vitest'
import { handoffRequest } from './handoff'
import { cliLauncher, detectT3Cli } from './t3-cli'

const home = mkdtempSync(join(tmpdir(), 'amc-t3-cli-'))
afterEach(() => rmSync(home, { recursive: true, force: true }))

it.each([false, true])(
  'detects the bundled CLI and its runtime-mode flag (%s)',
  async (supportsRuntimeMode) => {
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
      .mockResolvedValueOnce(
        `t3 thread start [flags] <project> <message>\n--json\n${supportsRuntimeMode ? '  --runtime-mode choice' : ''}`,
      )

    await expect(detectT3Cli(home, '', run)).resolves.toEqual({
      executable,
      baseDir,
      supportsRuntimeMode,
    })
    expect(run.mock.calls).toEqual([
      [join(oldHome, 'bin', 't3'), ['thread', 'start', '--help']],
      [executable, ['thread', 'start', '--help']],
    ])
  },
)

it('falls back to Connect when no local CLI supports thread start', async () => {
  await expect(detectT3Cli(home, '', vi.fn())).resolves.toBeNull()
})

it.each([false, true])(
  'passes the prompt over stdin and forwards runtime mode when supported (%s)',
  async (supportsRuntimeMode) => {
    const baseDir = join(home, 'T3 test profile')
    const state = join(baseDir, 'userdata')
    const executable = join(baseDir, 'bin', 't3')
    mkdirSync(state, { recursive: true })
    writeFileSync(join(state, 'environment-id'), 'local-env\n')
    writeFileSync(
      join(state, 'settings.json'),
      JSON.stringify({
        defaultRuntimeMode: 'auto',
        projectSettingsOverrides: { active: { defaultRuntimeMode: 'full-access' } },
      }),
    )
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
    const run = vi.fn().mockResolvedValue(JSON.stringify({ threadId: 'mcp:created' }))
    const launcher = cliLauncher({ executable, baseDir, supportsRuntimeMode }, run)

    await expect(launcher.projects()).resolves.toEqual([
      {
        id: 'active',
        title: 'Scratch',
        workspaceRoot: '/tmp/scratch',
        ...(supportsRuntimeMode ? {} : { localDefaultMode: 'full-access' }),
      },
    ])
    const launched = { threadId: 'mcp:created', link: 't3code://threads/local-env/mcp%3Acreated' }
    await expect(launcher.launch(request)).resolves.toEqual(launched)

    const runtime = supportsRuntimeMode ? ['--runtime-mode', 'approval-required'] : []
    expect(run.mock.calls).toEqual([
      [
        executable,
        [
          'thread',
          'start',
          '--base-dir',
          baseDir,
          '--json',
          ...runtime,
          '--title',
          request.title,
          '--',
          'active',
          '-',
        ],
        request.message,
      ],
    ])

    run.mockClear()
    const screenshot = '/tmp/synthetic feedback.png'
    const { runtimeMode: _runtimeMode, ...feedback } = request
    await expect(launcher.launch(feedback, screenshot)).resolves.toEqual(launched)
    expect(run).toHaveBeenCalledExactlyOnceWith(
      executable,
      [
        'thread',
        'start',
        '--base-dir',
        baseDir,
        '--json',
        '--title',
        request.title,
        '--',
        'active',
        '-',
      ],
      `${request.message}\nLocal screenshot: ${screenshot}`,
    )
  },
)
