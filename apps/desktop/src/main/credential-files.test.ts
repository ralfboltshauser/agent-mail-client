import {
  existsSync,
  mkdirSync,
  mkdtempSync,
  readFileSync,
  rmSync,
  statSync,
  writeFileSync,
} from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { afterEach, beforeEach, expect, it, vi } from 'vitest'
import { clearPairing, loadPairing, savePairing } from './auth'
import { savedT3Url } from './t3'

// Electron only supplies the profile path. These flows work without Safe Storage.
vi.mock('electron', () => ({ app: { getPath: () => profile }, shell: {} }))

const engineUrl = 'https://engine.example.test:4443'
let profile: string

beforeEach(() => {
  profile = mkdtempSync(join(tmpdir(), 'amc-credentials-'))
})

afterEach(() => rmSync(profile, { recursive: true, force: true }))

it('starts unpaired and saves, replaces and clears the owner token', () => {
  expect(loadPairing()).toEqual({ state: 'unpaired', engineUrl: null })

  const dir = join(profile, 'credentials')
  const path = join(dir, 'pairing.json')
  mkdirSync(dir, { mode: 0o755 })
  savePairing(engineUrl, 'first-token')
  savePairing(engineUrl, 'second-token')

  expect(statSync(dir).mode & 0o777).toBe(0o700)
  expect(statSync(path).mode & 0o777).toBe(0o600)
  expect(JSON.parse(readFileSync(path, 'utf8'))).toEqual({ engineUrl, token: 'second-token' })
  expect(loadPairing()).toEqual({ state: 'paired', engineUrl, token: 'second-token' })

  clearPairing()
  expect(existsSync(path)).toBe(false)
  expect(loadPairing()).toEqual({ state: 'unpaired', engineUrl: null })
})

it('archives encrypted owner pairing and remembers its Engine for re-pairing after a restart', () => {
  const path = join(profile, 'pairing.json')
  const archive = `${path}.legacy`
  const legacy = JSON.stringify({
    engineUrl,
    token: Buffer.from('v10ciphertext').toString('base64'),
  })
  writeFileSync(path, legacy, { mode: 0o600 })

  expect(loadPairing()).toEqual({ state: 'unpaired', engineUrl })
  expect(existsSync(path)).toBe(false)
  expect(readFileSync(archive, 'utf8')).toBe(legacy)
  expect(loadPairing()).toEqual({ state: 'unpaired', engineUrl })

  savePairing(engineUrl, 'replacement-token')

  expect(loadPairing()).toEqual({ state: 'paired', engineUrl, token: 'replacement-token' })
  expect(readFileSync(archive, 'utf8')).toBe(legacy)
})

it('reports a corrupt current pairing as a read error', () => {
  const dir = join(profile, 'credentials')
  mkdirSync(dir)
  writeFileSync(join(dir, 'pairing.json'), JSON.stringify({ engineUrl }))

  expect(loadPairing()).toMatchObject({
    state: 'read-error',
    engineUrl,
    failure: { errorClass: 'TypeError', kind: 'Request' },
  })
})

it('archives encrypted T3 credentials and loads a new T3 connection from the private directory', () => {
  const path = join(profile, 't3-pairing.json')
  const legacy = Buffer.from('v10ciphertext')
  writeFileSync(path, legacy, { mode: 0o600 })

  expect(savedT3Url()).toBe('')
  expect(existsSync(path)).toBe(false)
  expect(readFileSync(`${path}.legacy`)).toEqual(legacy)

  const url = 'https://t3.example.test/mcp'
  const dir = join(profile, 'credentials')
  mkdirSync(dir, { mode: 0o700 })
  writeFileSync(join(dir, 't3-pairing.json'), JSON.stringify({ url }), { mode: 0o600 })

  expect(savedT3Url()).toBe(url)
  expect(readFileSync(`${path}.legacy`)).toEqual(legacy)
})
