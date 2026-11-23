import { createHash } from 'node:crypto'
import {
  lstatSync,
  mkdirSync,
  mkdtempSync,
  readFileSync,
  rmSync,
  symlinkSync,
  writeFileSync,
} from 'node:fs'
import { tmpdir } from 'node:os'
import { dirname, join } from 'node:path'
import { afterEach, beforeEach, expect, it } from 'vitest'
import { installAgentSkills } from './skills.ts'

let home: string
let claudeHome: string
let codexSkill: string
let claudeSkill: string

beforeEach(() => {
  home = mkdtempSync(join(tmpdir(), 'amc-skills-test-'))
  claudeHome = join(home, 'claude-config')
  codexSkill = join(home, '.agents', 'skills', 'use-amc', 'SKILL.md')
  claudeSkill = join(claudeHome, 'skills', 'amc-triage', 'SKILL.md')
})

afterEach(() => rmSync(home, { recursive: true, force: true }))

it('installs both skills for both agents and preserves the private playbook on reruns', () => {
  const playbook = join(home, '.config', 'amc', 'mail-playbook.md')
  mkdirSync(dirname(playbook), { recursive: true })
  writeFileSync(playbook, 'My private preferences')

  const roots = installAgentSkills(home, claudeHome)
  expect(roots).toEqual([join(home, '.agents', 'skills'), join(claudeHome, 'skills')])
  for (const root of roots) {
    for (const name of ['use-amc', 'amc-triage']) {
      const path = join(root, name, 'SKILL.md')
      expect(readFileSync(path, 'utf8')).toMatch(new RegExp(`^---\nname: ${name}\n`))
      expect(lstatSync(path).mode & 0o777).toBe(0o600)
    }
  }

  const current = readFileSync(codexSkill, 'utf8')
  const oldSource = '# Older version\n'
  const digest = createHash('sha256').update(oldSource).digest('hex')
  writeFileSync(codexSkill, `${oldSource}\n<!-- AMC-managed skill: ${digest} -->\n`)
  installAgentSkills(home, claudeHome)
  expect(readFileSync(codexSkill, 'utf8')).toBe(current)
  expect(readFileSync(playbook, 'utf8')).toBe('My private preferences')
})

it('keeps personal edits to an installed skill even when the installer footer remains', () => {
  installAgentSkills(home, claudeHome)
  const edited = readFileSync(codexSkill, 'utf8').replace('# Use AMC', '# My mail workflow')
  writeFileSync(codexSkill, edited)

  expect(() => installAgentSkills(home, claudeHome)).toThrow(codexSkill)
  expect(readFileSync(codexSkill, 'utf8')).toBe(edited)
})

it('reports an unmanaged skill before writing any skills', () => {
  mkdirSync(dirname(claudeSkill), { recursive: true })
  writeFileSync(claudeSkill, 'My custom skill')

  expect(() => installAgentSkills(home, claudeHome)).toThrow(claudeSkill)
  expect(readFileSync(claudeSkill, 'utf8')).toBe('My custom skill')
  expect(lstatSync(codexSkill, { throwIfNoEntry: false })).toBeUndefined()
})

it('preserves a symlink at a skill destination', () => {
  mkdirSync(dirname(codexSkill), { recursive: true })
  const linkTarget = join(home, 'external.md')
  symlinkSync(linkTarget, codexSkill)

  expect(() => installAgentSkills(home, claudeHome)).toThrow(codexSkill)
  expect(lstatSync(codexSkill).isSymbolicLink()).toBe(true)
  expect(lstatSync(linkTarget, { throwIfNoEntry: false })).toBeUndefined()
})

it('preserves a shared agent skills directory', () => {
  const shared = join(home, 'shared')
  mkdirSync(shared)
  mkdirSync(join(home, '.agents'))
  symlinkSync(shared, join(home, '.agents', 'skills'))

  expect(() => installAgentSkills(home, claudeHome)).toThrow('owned by the current user')
  expect(lstatSync(join(shared, 'use-amc'), { throwIfNoEntry: false })).toBeUndefined()
})
