import { PAIRING_SCOPES, type Scope, type TokenKind } from '@amc/protocol'
import { type Db, transaction } from '../db/database.ts'
import { getSetting } from '../settings.ts'
import { newId, newPairingCode, newSecret, sha256 } from './secrets.ts'

export interface Principal {
  tokenId: string
  kind: TokenKind
  name: string
  scopes: Scope[]
  subject: string | null
  accountId?: string
}

interface TokenRow {
  id: string
  kind: TokenKind
  name: string
  scopes: string
  subject: string | null
  expires_at: number | null
  revoked_at: number | null
}

const PAIRING_CODE_TTL_MS = 10 * 60 * 1000

export interface IssuedToken {
  id: string
  secret: string
  kind: TokenKind
  scopes: Scope[]
}

export function issueToken(
  db: Db,
  input: {
    kind: TokenKind
    name: string
    scopes: readonly Scope[]
    subject?: string
    expiresAt?: number
  },
  now = Date.now(),
): IssuedToken {
  if (input.scopes.includes('send')) {
    if (input.kind === 'agent' && !getSetting(db, 'dangerouslyAllowSend')) {
      throw new Error(
        'An agent token can hold the send scope only while Dangerously Allow Send is on',
      )
    }
    if (input.kind !== 'desktop' && input.kind !== 'agent') {
      throw new Error(`A ${input.kind} token can never hold the send scope`)
    }
  }
  const id = newId('tok')
  const secret = newSecret('amc')
  db.prepare(
    `INSERT INTO token (id, kind, name, scopes, subject, hash, created_at, expires_at)
     VALUES (?, ?, ?, ?, ?, ?, ?, ?)`,
  ).run(
    id,
    input.kind,
    input.name,
    JSON.stringify(input.scopes),
    input.subject ?? null,
    sha256(secret),
    now,
    input.expiresAt ?? null,
  )
  return { id, secret, kind: input.kind, scopes: [...input.scopes] }
}

/** Resolves a bearer secret to its Principal, or null when unknown, revoked or expired. */
export function authenticate(db: Db, secret: string, now = Date.now()): Principal | null {
  const row = db
    .prepare(
      'SELECT id, kind, name, scopes, subject, expires_at, revoked_at FROM token WHERE hash = ?',
    )
    .get(sha256(secret)) as TokenRow | undefined
  if (!row || row.revoked_at !== null) return null
  if (row.expires_at !== null && row.expires_at <= now) return null
  db.prepare('UPDATE token SET last_used_at = ? WHERE id = ?').run(now, row.id)
  return {
    tokenId: row.id,
    kind: row.kind,
    name: row.name,
    scopes: JSON.parse(row.scopes) as Scope[],
    subject: row.subject,
  }
}

export function revokeToken(db: Db, id: string, now = Date.now()): boolean {
  const result = db
    .prepare('UPDATE token SET revoked_at = ? WHERE id = ? AND revoked_at IS NULL')
    .run(now, id)
  return result.changes > 0
}

export function listTokens(db: Db) {
  return db
    .prepare(
      `SELECT id, kind, name, scopes, created_at, last_used_at, expires_at, revoked_at
       FROM token ORDER BY created_at DESC`,
    )
    .all()
}

/** Creates a one-time pairing code. Run on the Host by the owner (`amc-engine pair`). */
export function createPairingCode(db: Db, kind: 'desktop' | 'cli', now = Date.now()): string {
  const code = newPairingCode()
  db.prepare(
    'INSERT INTO pairing_code (hash, kind, created_at, expires_at) VALUES (?, ?, ?, ?)',
  ).run(sha256(normalizeCode(code)), kind, now, now + PAIRING_CODE_TTL_MS)
  return code
}

/** Redeems a pairing code once and returns a fresh token for the paired device. */
export function redeemPairingCode(
  db: Db,
  code: string,
  deviceName: string,
  now = Date.now(),
): IssuedToken | null {
  return transaction(db, () => {
    const row = db
      .prepare(
        'SELECT hash, kind FROM pairing_code WHERE hash = ? AND used_at IS NULL AND expires_at > ?',
      )
      .get(sha256(normalizeCode(code)), now) as
      | { hash: string; kind: 'desktop' | 'cli' }
      | undefined
    if (!row) return null
    db.prepare('UPDATE pairing_code SET used_at = ? WHERE hash = ?').run(now, row.hash)
    return issueToken(
      db,
      { kind: row.kind, name: deviceName, scopes: PAIRING_SCOPES[row.kind] },
      now,
    )
  })
}

function normalizeCode(code: string): string {
  return code
    .trim()
    .toUpperCase()
    .replace(/[^A-Z0-9]/g, '')
}
