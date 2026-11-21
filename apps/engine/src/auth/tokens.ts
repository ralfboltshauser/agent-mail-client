import { PAIRING_SCOPES, type Scope, type TokenKind } from '@amc/protocol'
import { type Db, transaction } from '../db/database.ts'
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
  account_id: string | null
  revoked_at: number | null
}

export const MAX_AGENT_DAYS = 90
export const DAY_MS = 86_400_000

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
    accountId?: string
    expiresAt?: number
  },
  now = Date.now(),
): IssuedToken {
  if (input.scopes.includes('send') && input.kind !== 'desktop')
    throw new Error(`A ${input.kind} token can never hold the send scope`)
  if (input.kind === 'agent') {
    if (input.scopes.includes('admin')) throw new Error('Agent tokens cannot hold the admin scope')
    const expiry = input.expiresAt
    if (
      expiry === undefined ||
      !Number.isSafeInteger(expiry) ||
      expiry <= now ||
      expiry > now + MAX_AGENT_DAYS * DAY_MS
    )
      throw new Error('Agent tokens require an expiry of at most 90 days')
    if (
      input.accountId !== undefined &&
      !db.prepare('SELECT 1 FROM account WHERE id = ?').get(input.accountId)
    )
      throw new Error('Choose an existing Account')
  }
  const id = newId('tok')
  const secret = newSecret('amc')
  db.prepare(
    `INSERT INTO token (id, kind, name, scopes, subject, hash, created_at, expires_at, account_id)
     VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?)`,
  ).run(
    id,
    input.kind,
    input.name,
    JSON.stringify(input.scopes),
    input.subject ?? null,
    sha256(secret),
    now,
    input.expiresAt ?? null,
    input.accountId ?? null,
  )
  return { id, secret, kind: input.kind, scopes: [...input.scopes] }
}

/** Resolves a bearer secret to its Principal, or null when unknown, revoked or expired. */
export function authenticate(db: Db, secret: string, now = Date.now()): Principal | null {
  const row = db
    .prepare(
      'SELECT id, kind, name, scopes, subject, expires_at, revoked_at, account_id FROM token WHERE hash = ?',
    )
    .get(sha256(secret)) as TokenRow | undefined
  if (!row || row.revoked_at !== null) return null
  if (row.kind === 'agent' && row.expires_at === null) return null
  if (row.expires_at !== null && row.expires_at <= now) return null
  db.prepare('UPDATE token SET last_used_at = ? WHERE id = ?').run(now, row.id)
  const scopes = JSON.parse(row.scopes) as Scope[]
  return {
    tokenId: row.id,
    kind: row.kind,
    name: row.name,
    scopes:
      row.kind === 'agent'
        ? scopes.filter((scope) => scope !== 'send' && scope !== 'admin')
        : scopes,
    subject: row.subject,
    ...(row.kind === 'agent' && row.account_id !== null ? { accountId: row.account_id } : {}),
  }
}

export function invalidTokenMessage(db: Db, secret: string): string {
  const legacy =
    secret &&
    db
      .prepare("SELECT 1 FROM token WHERE hash = ? AND kind = 'agent' AND expires_at IS NULL")
      .get(sha256(secret))
  return legacy
    ? 'This legacy Agent token has no expiry. Ask the owner to re-issue it with amc token create --agent <name> --expires 30d.'
    : 'Missing, expired or revoked token'
}

// Check the current grant before dispatching queued Agent work.
export function canAgentOrganize(db: Db, tokenId: string, accountId: string, now: number): boolean {
  return Boolean(
    db
      .prepare(`
    SELECT 1 FROM token WHERE id = ? AND kind = 'agent' AND revoked_at IS NULL AND expires_at > ?
      AND (account_id IS NULL OR account_id = ?)
      AND 'organize' IN (SELECT value FROM json_each(token.scopes))
  `)
      .get(tokenId, now, accountId),
  )
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
      `SELECT id, kind, name, scopes, created_at, last_used_at, expires_at, revoked_at, account_id
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
