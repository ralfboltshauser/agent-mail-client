import { createHash } from 'node:crypto'
import {
  linkSync,
  lstatSync,
  mkdirSync,
  mkdtempSync,
  readdirSync,
  readFileSync,
  renameSync,
  rmSync,
  writeFileSync,
} from 'node:fs'
import { homedir } from 'node:os'
import { dirname, join, resolve } from 'node:path'
import type { Command } from 'commander'

declare const AMC_AGENT_SKILLS: Record<string, string> | undefined
const marker = /\n<!-- AMC-managed skill: ([a-f0-9]{64}) -->\n$/

function managedContent(source: string): string {
  const digest = createHash('sha256').update(source).digest('hex')
  return `${source}\n<!-- AMC-managed skill: ${digest} -->\n`
}

function bundledSkills(): Record<string, string> {
  if (typeof AMC_AGENT_SKILLS !== 'undefined') return AMC_AGENT_SKILLS
  const source = new URL('../skills/', import.meta.url)
  return Object.fromEntries(
    readdirSync(source, { withFileTypes: true })
      .filter((entry) => entry.isDirectory())
      .map(({ name }) => [name, readFileSync(new URL(`${name}/SKILL.md`, source), 'utf8')]),
  )
}

export function installAgentSkills(home: string, claudeHome: string): string[] {
  const uid = process.getuid?.()
  const configs = new Set([join(home, '.agents'), resolve(claudeHome)])
  const roots = [...configs].map((config) => join(config, 'skills'))
  for (const path of [...configs, ...roots]) {
    const info = lstatSync(path, { throwIfNoEntry: false })
    if (info && (!info.isDirectory() || info.uid !== uid)) {
      throw new Error(`Choose a skill directory owned by the current user: ${path}`)
    }
  }
  const skills = Object.entries(bundledSkills())
  const files = roots.flatMap((root) =>
    skills.map(([name, source]) => {
      const folder = join(root, name)
      const path = join(folder, 'SKILL.md')
      const folderInfo = lstatSync(folder, { throwIfNoEntry: false })
      if (folderInfo && (!folderInfo.isDirectory() || folderInfo.uid !== uid)) {
        throw new Error(`Move the existing skill folder aside and retry: ${folder}`)
      }
      const info = lstatSync(path, { throwIfNoEntry: false })
      const previous = info?.isFile() && info.uid === uid ? readFileSync(path, 'utf8') : undefined
      const original = previous?.replace(marker, '')
      if (info && (original === undefined || previous !== managedContent(original))) {
        throw new Error(`Move the existing skill aside and retry: ${path}`)
      }
      return { path, content: managedContent(source), previous }
    }),
  )

  for (const { path, content, previous } of files) {
    if (content === previous) continue
    const folder = dirname(path)
    mkdirSync(folder, { recursive: true, mode: 0o700 })
    const staging = mkdtempSync(join(folder, '.amc-'))
    const file = join(staging, 'SKILL.md')
    try {
      writeFileSync(file, content, { mode: 0o600 })
      // Publish complete files and avoid replacing a newly created custom skill.
      if (previous === undefined) linkSync(file, path)
      else renameSync(file, path)
    } finally {
      rmSync(staging, { recursive: true, force: true })
    }
  }
  return roots
}

export function registerSkillCommands(program: Command): void {
  program
    .command('skills')
    .description('Manage AMC skills for your coding agents')
    .command('install')
    .description('Install or update AMC skills for the current user')
    .action(() => {
      if (process.getuid?.() === 0) {
        throw new Error('Run amc skills install as the user who will use the skills, without sudo.')
      }
      const home = homedir()
      const claudeHome = process.env.CLAUDE_CONFIG_DIR || join(home, '.claude')
      for (const root of installAgentSkills(home, claudeHome)) {
        console.log(`Installed use-amc and amc-triage in ${root}`)
      }
    })
}
