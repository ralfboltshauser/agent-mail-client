import { createHash, randomBytes } from 'node:crypto'
import { readFileSync } from 'node:fs'
import { join } from 'node:path'

export const GMAIL_SCOPE = 'https://www.googleapis.com/auth/gmail.modify'
export const GMAIL_TIMEOUT_MS = 30_000
const AUTH_URL = 'https://accounts.google.com/o/oauth2/v2/auth'
const TOKEN_URL = 'https://oauth2.googleapis.com/token'

export interface OAuthClient {
  clientId: string
  clientSecret: string
}

export interface GmailCredentials {
  refreshToken: string
  scope: string
}

/** Reads the owner's Desktop OAuth client (downloaded from Google Cloud) from the secrets dir. */
export function loadOAuthClient(secretsDir: string): OAuthClient {
  const path = join(secretsDir, 'google-oauth-client.json')
  let raw: { installed?: { client_id?: string; client_secret?: string } }
  try {
    raw = JSON.parse(readFileSync(path, 'utf8'))
  } catch (error) {
    throw new Error(`Cannot read the Google OAuth client at ${path}: ${(error as Error).message}`)
  }
  const installed = raw.installed
  if (!installed?.client_id || !installed.client_secret) {
    throw new Error(`${path} is not a Desktop app OAuth client (expected "installed")`)
  }
  return { clientId: installed.client_id, clientSecret: installed.client_secret }
}

export function newPkce() {
  const verifier = randomBytes(48).toString('base64url')
  const challenge = createHash('sha256').update(verifier).digest('base64url')
  return { verifier, challenge }
}

export function authorizationUrl(
  client: OAuthClient,
  input: { redirectUri: string; state: string; codeChallenge: string; loginHint?: string },
): string {
  const url = new URL(AUTH_URL)
  url.search = new URLSearchParams({
    client_id: client.clientId,
    redirect_uri: input.redirectUri,
    response_type: 'code',
    scope: GMAIL_SCOPE,
    access_type: 'offline',
    // Always ask, so Google always returns a refresh token (also on re-auth).
    prompt: 'consent',
    include_granted_scopes: 'true',
    state: input.state,
    code_challenge: input.codeChallenge,
    code_challenge_method: 'S256',
    ...(input.loginHint ? { login_hint: input.loginHint } : {}),
  }).toString()
  return url.toString()
}

export class OAuthError extends Error {
  readonly code: string

  constructor(code: string, message: string) {
    super(message)
    this.code = code
  }

  /** The refresh token was revoked or expired: the owner has to sign in again. */
  get needsReauth(): boolean {
    return this.code === 'invalid_grant'
  }
}

interface TokenResponse {
  access_token: string
  expires_in: number
  refresh_token?: string
  scope?: string
}

async function tokenRequest(
  params: Record<string, string>,
  fetchImpl: typeof fetch,
): Promise<TokenResponse> {
  const res = await fetchImpl(TOKEN_URL, {
    method: 'POST',
    signal: AbortSignal.timeout(GMAIL_TIMEOUT_MS),
    headers: { 'Content-Type': 'application/x-www-form-urlencoded' },
    body: new URLSearchParams(params),
  })
  const body = (await res.text().then((text) => {
    try {
      return JSON.parse(text) ?? {}
    } catch {
      // A non-JSON response is classified by the token exchange below.
      return {}
    }
  })) as Partial<TokenResponse> & {
    error?: string
    error_description?: string
  }
  if (!res.ok || !body.access_token) {
    throw new OAuthError(
      body.error ?? `http_${res.status}`,
      body.error_description ?? body.error ?? res.statusText,
    )
  }
  return body as TokenResponse
}

export async function exchangeCode(
  client: OAuthClient,
  input: { code: string; redirectUri: string; codeVerifier: string },
  fetchImpl: typeof fetch = fetch,
): Promise<{ credentials: GmailCredentials; accessToken: string; expiresAt: number }> {
  const res = await tokenRequest(
    {
      grant_type: 'authorization_code',
      code: input.code,
      redirect_uri: input.redirectUri,
      code_verifier: input.codeVerifier,
      client_id: client.clientId,
      client_secret: client.clientSecret,
    },
    fetchImpl,
  )
  if (!res.refresh_token)
    throw new OAuthError('no_refresh_token', 'Google did not return a refresh token')
  if (!res.scope?.split(' ').includes(GMAIL_SCOPE)) {
    throw new OAuthError(
      'scope_denied',
      'Gmail access was not granted; tick the Gmail checkbox on the consent screen',
    )
  }
  return {
    credentials: { refreshToken: res.refresh_token, scope: res.scope },
    accessToken: res.access_token,
    expiresAt: Date.now() + res.expires_in * 1000,
  }
}

/** Keeps a fresh access token for one Account, refreshing a minute before it expires. */
export class AccessTokens {
  readonly #client: OAuthClient
  readonly #credentials: GmailCredentials
  readonly #fetch: typeof fetch
  #token: { value: string; expiresAt: number } | null = null
  #pending: Promise<string> | null = null

  constructor(client: OAuthClient, credentials: GmailCredentials, fetchImpl: typeof fetch = fetch) {
    this.#client = client
    this.#credentials = credentials
    this.#fetch = fetchImpl
  }

  seed(value: string, expiresAt: number): void {
    this.#token = { value, expiresAt }
  }

  invalidate(): void {
    this.#token = null
  }

  async get(): Promise<string> {
    if (this.#token && this.#token.expiresAt - 60_000 > Date.now()) return this.#token.value
    this.#pending ??= tokenRequest(
      {
        grant_type: 'refresh_token',
        refresh_token: this.#credentials.refreshToken,
        client_id: this.#client.clientId,
        client_secret: this.#client.clientSecret,
      },
      this.#fetch,
    )
      .then((res) => {
        this.#token = { value: res.access_token, expiresAt: Date.now() + res.expires_in * 1000 }
        return res.access_token
      })
      .finally(() => {
        this.#pending = null
      })
    return this.#pending
  }
}
