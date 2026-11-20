import { PAIRING_SCOPES } from '@amc/protocol'
import { describe, expect, it } from 'vitest'
import { setSetting } from '../settings.ts'
import { testDb } from '../test-support.ts'
import {
  authenticate,
  createPairingCode,
  issueToken,
  redeemPairingCode,
  revokeToken,
} from './tokens.ts'

describe('tokens', () => {
  it('authenticates an issued token and never stores the secret', () => {
    const db = testDb()
    const issued = issueToken(db, { kind: 'cli', name: 'mac', scopes: ['read'] })
    expect(authenticate(db, issued.secret)?.tokenId).toBe(issued.id)
    const stored = JSON.stringify(db.prepare('SELECT * FROM token').all())
    expect(stored).not.toContain(issued.secret)
  })

  it('refuses unknown, revoked and expired tokens', () => {
    const db = testDb()
    expect(authenticate(db, 'amc_nope')).toBeNull()
    const revoked = issueToken(db, { kind: 'cli', name: 'a', scopes: ['read'] })
    revokeToken(db, revoked.id)
    expect(authenticate(db, revoked.secret)).toBeNull()
    const expired = issueToken(db, { kind: 'cli', name: 'b', scopes: ['read'], expiresAt: 1000 }, 0)
    expect(authenticate(db, expired.secret, 2000)).toBeNull()
  })
})

describe('the send scope (ADR 0001, ADR 0003)', () => {
  it('can never be given to the CLI or a composer link', () => {
    const db = testDb()
    expect(() => issueToken(db, { kind: 'cli', name: 'x', scopes: ['send'] })).toThrow()
    expect(() => issueToken(db, { kind: 'composer', name: 'x', scopes: ['send'] })).toThrow()
  })

  it('is refused to agents while Dangerously Allow Send is off', () => {
    const db = testDb()
    expect(() => issueToken(db, { kind: 'agent', name: 'x', scopes: ['send'] })).toThrow()
    setSetting(db, 'dangerouslyAllowSend', true)
    expect(issueToken(db, { kind: 'agent', name: 'x', scopes: ['send'] }).scopes).toContain('send')
  })

  it('is not part of CLI pairing', () => {
    expect(PAIRING_SCOPES.cli).not.toContain('send')
  })
})

describe('pairing', () => {
  it('redeems a code once, case- and dash-insensitive', () => {
    const db = testDb()
    const code = createPairingCode(db, 'cli')
    const issued = redeemPairingCode(db, code.toLowerCase().replace('-', ''), 'mac')
    expect(issued?.kind).toBe('cli')
    expect(issued?.scopes).toEqual([...PAIRING_SCOPES.cli])
    expect(redeemPairingCode(db, code, 'again')).toBeNull()
  })

  it('refuses an expired code', () => {
    const db = testDb()
    const code = createPairingCode(db, 'desktop', 0)
    expect(redeemPairingCode(db, code, 'mac', 11 * 60 * 1000)).toBeNull()
  })
})
