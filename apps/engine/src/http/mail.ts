import { GmailAuthComplete, GmailAuthStart } from '@amc/protocol'
import { Hono } from 'hono'
import { upsertGmailAccount } from '../accounts.ts'
import { newSecret } from '../auth/secrets.ts'
import type { BlobStore } from '../blobs.ts'
import type { Sealer } from '../crypto.ts'
import type { Db } from '../db/database.ts'
import type { Logger } from '../log.ts'
import type { MailQueries } from '../mail/queries.ts'
import type { MailStore } from '../mail/store.ts'
import { GmailHttpApi } from '../providers/gmail/http.ts'
import {
  AccessTokens,
  authorizationUrl,
  exchangeCode,
  newPkce,
  type OAuthClient,
  OAuthError,
} from '../providers/gmail/oauth.ts'
import type { SyncManager } from '../sync/manager.ts'
import { type AppEnv, requireScope } from './app.ts'

export interface MailDeps {
  db: Db
  store: MailStore
  queries: MailQueries
  blobs: BlobStore
  sealer: Sealer
  sync: SyncManager
  oauthClient: () => OAuthClient
  log: Logger
  fetchImpl?: typeof fetch
}

const OAUTH_TTL_MS = 10 * 60 * 1000

function intParam(value: string | undefined): number | undefined {
  if (value === undefined || value === '') return undefined
  const n = Number(value)
  return Number.isFinite(n) ? n : undefined
}

/** Accounts, Labels, Threads, search, bodies and attachments (read side + adding Accounts). */
export function mailRoutes(deps: MailDeps) {
  const { db, queries, log } = deps
  const r = new Hono<AppEnv>()

  r.get('/accounts', requireScope('read'), (c) => c.json({ accounts: queries.accounts() }))

  // Adding a Gmail Account: the Client opens authUrl in a browser with a loopback redirect on
  // its own machine, then hands the code back here. The Engine alone exchanges and keeps it.
  r.post('/accounts/gmail/start', requireScope('admin'), async (c) => {
    const parsed = GmailAuthStart.safeParse(await c.req.json().catch(() => null))
    if (!parsed.success)
      return c.json({ error: 'bad_request', message: 'Expected redirectUri' }, 400)
    const redirect = new URL(parsed.data.redirectUri)
    if (
      redirect.protocol !== 'http:' ||
      !['127.0.0.1', 'localhost', '[::1]'].includes(redirect.hostname)
    ) {
      return c.json(
        { error: 'bad_request', message: 'redirectUri must be a loopback http URL' },
        400,
      )
    }
    const state = newSecret('st', 24)
    const pkce = newPkce()
    const now = Date.now()
    db.prepare('DELETE FROM oauth_pending WHERE created_at < ?').run(now - OAUTH_TTL_MS)
    db.prepare(
      "INSERT INTO oauth_pending (state, provider, code_verifier, redirect_uri, created_at) VALUES (?, 'gmail', ?, ?, ?)",
    ).run(state, pkce.verifier, parsed.data.redirectUri, now)
    const authUrl = authorizationUrl(deps.oauthClient(), {
      redirectUri: parsed.data.redirectUri,
      state,
      codeChallenge: pkce.challenge,
    })
    return c.json({ authUrl, state })
  })

  r.post('/accounts/gmail/complete', requireScope('admin'), async (c) => {
    const parsed = GmailAuthComplete.safeParse(await c.req.json().catch(() => null))
    if (!parsed.success)
      return c.json({ error: 'bad_request', message: 'Expected code and state' }, 400)
    const pending = db
      .prepare(
        "SELECT code_verifier, redirect_uri, created_at FROM oauth_pending WHERE state = ? AND provider = 'gmail'",
      )
      .get(parsed.data.state) as
      | { code_verifier: string; redirect_uri: string; created_at: number }
      | undefined
    db.prepare('DELETE FROM oauth_pending WHERE state = ?').run(parsed.data.state)
    if (!pending || pending.created_at < Date.now() - OAUTH_TTL_MS) {
      return c.json({ error: 'invalid_state', message: 'Sign-in expired; start again' }, 400)
    }
    try {
      const client = deps.oauthClient()
      const { credentials, accessToken, expiresAt } = await exchangeCode(
        client,
        {
          code: parsed.data.code,
          redirectUri: pending.redirect_uri,
          codeVerifier: pending.code_verifier,
        },
        deps.fetchImpl,
      )
      const tokens = new AccessTokens(client, credentials, deps.fetchImpl)
      tokens.seed(accessToken, expiresAt)
      const profile = await new GmailHttpApi(tokens, deps.fetchImpl).profile()
      const { id, created } = upsertGmailAccount(db, deps.store, deps.sealer, {
        address: profile.emailAddress,
        credentials,
      })
      deps.sync.startAccount(id)
      log.info({ account: id, created }, 'gmail account signed in')
      return c.json({ accountId: id, address: profile.emailAddress, created })
    } catch (error) {
      const message =
        error instanceof OAuthError ? error.message : 'Could not complete the Google sign-in'
      log.warn({ err: (error as Error).message }, 'gmail sign-in failed')
      return c.json({ error: 'oauth_failed', message }, 400)
    }
  })

  r.get('/labels', requireScope('read'), (c) =>
    c.json({ labels: queries.labels(c.req.query('accountId')) }),
  )

  r.get('/threads', requireScope('read'), (c) => {
    const q = c.req.query()
    return c.json(
      queries.threads({
        accountId: q.accountId,
        labelId: q.labelId,
        inbox: q.inbox === '1' || q.inbox === 'true',
        unread: q.unread === '1' || q.unread === 'true',
        before: intParam(q.before),
        limit: intParam(q.limit),
      }),
    )
  })

  r.get('/threads/:id', requireScope('read'), (c) => {
    const thread = queries.thread(c.req.param('id'))
    return thread ? c.json(thread) : c.json({ error: 'not_found', message: 'No such Thread' }, 404)
  })

  r.get('/search', requireScope('read'), (c) => {
    const text = c.req.query('q') ?? ''
    return c.json({
      hits: queries.search(text, {
        accountId: c.req.query('accountId'),
        limit: intParam(c.req.query('limit')),
      }),
    })
  })

  r.get('/messages/:id/html', requireScope('read'), (c) => {
    const hash = queries.messageHtmlBlob(c.req.param('id'))
    const html = hash ? deps.blobs.get(hash) : null
    if (!html) return c.json({ error: 'not_found', message: 'This message has no HTML body' }, 404)
    return c.json({ html: html.toString('utf8') })
  })

  // Attachments are fetched from the provider on first open, then kept in the blob store.
  r.get('/attachments/:id', requireScope('read'), async (c) => {
    const row = db
      .prepare(
        `SELECT a.filename, a.mime_type, a.blob, a.provider_attachment, m.provider_id, m.account_id
         FROM attachment a JOIN message m ON m.id = a.message_id WHERE a.id = ?`,
      )
      .get(c.req.param('id')) as
      | {
          filename: string
          mime_type: string
          blob: string | null
          provider_attachment: string | null
          provider_id: string
          account_id: string
        }
      | undefined
    if (!row) return c.json({ error: 'not_found', message: 'No such attachment' }, 404)
    let hash = row.blob
    if (!hash) {
      const api = deps.sync.gmailApi(row.account_id)
      if (!api || !row.provider_attachment) {
        return c.json(
          { error: 'unavailable', message: 'The Account is not syncing right now' },
          503,
        )
      }
      const data = await api.attachment(row.provider_id, row.provider_attachment)
      hash = deps.blobs.put(data)
      db.prepare('UPDATE attachment SET blob = ? WHERE id = ?').run(hash, c.req.param('id'))
    }
    const data = deps.blobs.get(hash)
    if (!data) return c.json({ error: 'not_found', message: 'Attachment data is missing' }, 404)
    return c.body(new Uint8Array(data), 200, {
      'Content-Type': row.mime_type,
      'Content-Disposition': `attachment; filename*=UTF-8''${encodeURIComponent(row.filename || 'attachment')}`,
      'X-Content-Type-Options': 'nosniff',
    })
  })

  return r
}
