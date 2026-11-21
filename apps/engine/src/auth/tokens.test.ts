import { PAIRING_SCOPES } from '@amc/protocol'
import { describe, expect, it } from 'vitest'
import { migrate, openDatabase } from '../db/database.ts'
import { MIGRATIONS } from '../db/migrations.ts'
import { setSetting } from '../settings.ts'
import { testDb } from '../test-support.ts'
import { sha256 } from './secrets.ts'
import {
  authenticate,
  createPairingCode,
  DAY_MS,
  invalidTokenMessage,
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

describe('Agent grants', () => {
  it('requires a future expiry of at most 90 days and preserves revoke', () => {
    const db = testDb()
    const grant = { kind: 'agent', name: 'test', scopes: ['read'] } as const
    expect(() => issueToken(db, grant, 0)).toThrow(/expiry/)
    for (const expiresAt of [0, -1, Number.NaN, 90 * DAY_MS + 1])
      expect(() => issueToken(db, { ...grant, expiresAt }, 0)).toThrow(/expiry/)
    const token = issueToken(db, { ...grant, expiresAt: 90 * DAY_MS }, 0)
    expect(authenticate(db, token.secret, 1)).toMatchObject({ kind: 'agent' })
    expect(authenticate(db, token.secret, 90 * DAY_MS)).toBeNull()
    expect(revokeToken(db, token.id, 2)).toBe(true)
    expect(authenticate(db, token.secret, 3)).toBeNull()
  })

  it('revokes pre-M6 Agent tokens while preserving the owner and explains missing expiry', () => {
    const db = openDatabase(':memory:')
    migrate(db, { migrations: MIGRATIONS.filter(({ version }) => version <= 9) })
    for (const [id, kind] of [
      ['legacy', 'agent'],
      ['owner', 'cli'],
    ] as const) {
      db.prepare(`
        INSERT INTO token (id, kind, name, scopes, hash, created_at)
        VALUES (?, ?, ?, '["read"]', ?, 0)
      `).run(id, kind, id, sha256(id))
    }
    migrate(db)
    expect(authenticate(db, 'legacy')).toBeNull()
    expect(invalidTokenMessage(db, 'legacy')).toMatch(/re-issue/)
    expect(
      db.prepare("SELECT revoked_at FROM token WHERE id = 'legacy'").get()?.revoked_at,
    ).toBeTypeOf('number')
    expect(authenticate(db, 'owner')).toMatchObject({ kind: 'cli' })
    db.prepare("UPDATE token SET revoked_at = NULL WHERE id = 'legacy'").run()
    expect(authenticate(db, 'legacy')).toBeNull()
  })
})

describe('the send scope (ADR 0001, ADR 0003)', () => {
  it('can never be given to the CLI or a composer link', () => {
    const db = testDb()
    expect(() => issueToken(db, { kind: 'cli', name: 'x', scopes: ['send'] })).toThrow()
    expect(() => issueToken(db, { kind: 'composer', name: 'x', scopes: ['send'] })).toThrow()
  })

  it('is always refused to Agents, including with the legacy setting enabled', () => {
    const db = testDb()
    for (const enabled of [false, true]) {
      setSetting(db, 'dangerouslyAllowSend', enabled)
      for (const scope of ['send', 'admin'] as const) {
        expect(() =>
          issueToken(db, {
            kind: 'agent',
            name: 'x',
            scopes: [scope],
            expiresAt: Date.now() + DAY_MS,
          }),
        ).toThrow()
      }
    }
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
