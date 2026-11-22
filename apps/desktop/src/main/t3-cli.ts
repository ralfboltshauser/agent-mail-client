import { execFile } from 'node:child_process'
import { accessSync, constants, readdirSync, readFileSync } from 'node:fs'
import { homedir } from 'node:os'
import { isAbsolute, join } from 'node:path'
import { DatabaseSync } from 'node:sqlite'
import type { T3Project, T3RuntimeMode } from '../shared/api'
import { handoffTitle, type T3Launcher, type T3Thread } from './handoff'

export interface T3Cli {
  executable: string
  baseDir: string
  supportsRuntimeMode?: boolean
}

type RunCli = (executable: string, args: string[], input?: string) => Promise<string>

const runCli: RunCli = (executable, args, input) =>
  new Promise((resolve, reject) => {
    const child = execFile(
      executable,
      args,
      { timeout: 30_000, maxBuffer: 16 * 1024 * 1024 },
      (error, stdout) => {
        // CLI errors can include the prompt. Keep raw stderr and stdout out of IPC errors.
        if (error) reject(new Error('T3 CLI command failed.'))
        else resolve(stdout)
      },
    )
    child.stdin?.on('error', (error) => reject(error))
    child.stdin?.end(input)
  })

export async function detectT3Cli(
  home = homedir(),
  configuredHome = process.env.T3CODE_HOME,
  run: RunCli = runCli,
): Promise<T3Cli | null> {
  const share = join(home, '.local', 'share')
  const profiles = readdirProfiles(share)
  for (const baseDir of new Set([configuredHome, join(home, '.t3'), ...profiles])) {
    if (!baseDir || !isAbsolute(baseDir)) continue
    const executable = join(baseDir, 'bin', 't3')
    try {
      accessSync(executable, constants.X_OK)
      accessSync(join(baseDir, 'userdata', 'statev2.sqlite'), constants.R_OK)
      const help = await run(executable, ['thread', 'start', '--help'])
      if (help.includes('t3 thread start') && help.includes('--json'))
        return {
          executable,
          baseDir,
          supportsRuntimeMode: /^\s*--runtime-mode(?:[\s,=]|$)/m.test(help),
        }
    } catch {
      // Older or moved desktop installs can leave a shim behind.
    }
  }
  return null
}

function readdirProfiles(share: string): string[] {
  try {
    return readdirSync(share)
      .filter((name) => name === 't3code' || name.startsWith('t3code-'))
      .sort()
      .map((name) => join(share, name))
  } catch {
    return []
  }
}

function projectRuntimeModes(state: string): (id: string) => T3RuntimeMode | 'unknown' {
  const mode = (value: unknown): T3RuntimeMode | 'unknown' => {
    switch (value) {
      case 'approval-required':
      case 'auto-accept-edits':
      case 'auto':
      case 'full-access':
        return value
      default:
        return 'unknown'
    }
  }
  try {
    const settings = JSON.parse(readFileSync(join(state, 'settings.json'), 'utf8')) as {
      defaultRuntimeMode?: unknown
      projectSettingsOverrides?: Record<string, { defaultRuntimeMode?: unknown }>
    }
    return (id) =>
      mode(
        settings.projectSettingsOverrides?.[id]?.defaultRuntimeMode ??
          settings.defaultRuntimeMode ??
          'full-access',
      )
  } catch (error) {
    return () => ((error as NodeJS.ErrnoException).code === 'ENOENT' ? 'full-access' : 'unknown')
  }
}

export function cliLauncher(
  { executable, baseDir, supportsRuntimeMode }: T3Cli,
  run: RunCli = runCli,
): T3Launcher {
  const state = join(baseDir, 'userdata')
  const flags = ['--base-dir', baseDir, '--json']

  const environmentId = () => {
    const environment = readFileSync(join(state, 'environment-id'), 'utf8').trim()
    if (!environment) throw new Error('Missing T3 environment ID.')
    return environment
  }
  const threadLink = (environment: string, threadId: string) =>
    `t3code://threads/${encodeURIComponent(environment)}/${encodeURIComponent(threadId)}`

  return {
    key: `cli:${baseDir}`,
    async projects() {
      try {
        // The installed CLI resolves projects internally but has no project list command.
        using db = new DatabaseSync(join(state, 'statev2.sqlite'), { readOnly: true })
        const projects = db
          .prepare(`
          SELECT project_id AS id, title
          FROM projection_projects
          WHERE deleted_at IS NULL AND archived_at IS NULL AND workspace_root <> ''
          ORDER BY title COLLATE NOCASE, project_id
        `)
          .all() as unknown as T3Project[]
        if (supportsRuntimeMode) return projects
        const runtimeMode = projectRuntimeModes(state)
        return projects.map((project) => ({
          ...project,
          localDefaultMode: runtimeMode(project.id),
        }))
      } catch {
        throw new Error('AMC could not read local T3 projects. Open T3 Code and try again.')
      }
    },
    async find(projectId, launchId) {
      try {
        const threads = JSON.parse(
          await run(executable, ['thread', 'list', ...flags, '--project', projectId]),
        ) as Array<T3Thread & { title: string }>
        const title = handoffTitle(launchId)
        const thread = threads.find((item) => item.title === title)
        return thread
          ? { threadId: thread.threadId, link: threadLink(environmentId(), thread.threadId) }
          : null
      } catch {
        throw new Error('T3 could not check the earlier hand-off. Open T3 Code and retry.')
      }
    },
    async launch(request) {
      try {
        // Check we can construct a navigation link before handing off the prompt.
        const environment = environmentId()
        const runtime = supportsRuntimeMode ? ['--runtime-mode', request.runtimeMode] : []
        const thread = JSON.parse(
          await run(
            executable,
            [
              'thread',
              'start',
              ...flags,
              ...runtime,
              '--title',
              request.title,
              '--',
              request.projectId,
              '-',
            ],
            request.message,
          ),
        ) as T3Thread
        if (typeof thread?.threadId !== 'string' || !thread.threadId)
          throw new Error('Missing thread ID.')
        return { threadId: thread.threadId, link: threadLink(environment, thread.threadId) }
      } catch {
        throw new Error(
          'T3 could not confirm the launch. Check that T3 Code is running, then retry.',
        )
      }
    },
  }
}
