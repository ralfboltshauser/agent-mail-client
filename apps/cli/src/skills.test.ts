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
  writeFileSync(codexSkill, current.replace('# Use AMC', '# Older version'))
  installAgentSkills(home, claudeHome)
  expect(readFileSync(codexSkill, 'utf8')).toBe(current)
  expect(readFileSync(playbook, 'utf8')).toBe('My private preferences')
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
