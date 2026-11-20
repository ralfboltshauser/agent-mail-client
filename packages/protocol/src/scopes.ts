/**
 * What a token may do. The Engine computes every Client's tools and routes from these,
 * so a missing scope means the capability does not exist for that Client (ADR 0001).
 */
export const SCOPES = ['read', 'organize', 'draft', 'send', 'admin'] as const
export type Scope = (typeof SCOPES)[number]

/** The kinds of Client that hold a token. */
export const TOKEN_KINDS = ['desktop', 'cli', 'agent', 'composer'] as const
export type TokenKind = (typeof TOKEN_KINDS)[number]

/**
 * Scopes each kind gets when paired. Only the desktop app can send: the CLI and every
 * Agent run as the owner's Unix user next to coding agents, so they never hold `send`
 * (ADR 0001, ADR 0003). Agent tokens get `send` only while Dangerously Allow Send is on.
 */
export const PAIRING_SCOPES: Record<'desktop' | 'cli', readonly Scope[]> = {
  desktop: ['read', 'organize', 'draft', 'send', 'admin'],
  cli: ['read', 'organize', 'draft', 'admin'],
}

export function hasScope(granted: readonly Scope[], needed: Scope): boolean {
  return granted.includes(needed)
}
