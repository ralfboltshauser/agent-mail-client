import { createReadStream, statSync } from 'node:fs'
import { Readable } from 'node:stream'
import {
  GmailAuthComplete,
  GmailAuthStart,
  type ImapAccountAdded,
  ImapAccountInput,
} from '@amc/protocol'
import { Hono } from 'hono'
import { AccountConflict, upsertGmailAccount, upsertImapAccount } from '../accounts.ts'
import { newSecret } from '../auth/secrets.ts'
import type { BlobStore } from '../blobs.ts'
import type { Sealer } from '../crypto.ts'
import type { Db } from '../db/database.ts'
import type { Logger } from '../log.ts'
import { DraftError, type Drafts, searchContacts } from '../mail/drafts.ts'
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
import { verifyImapAccount } from '../providers/imap/client.ts'
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
  drafts: Drafts
  log: Logger
  fetchImpl?: typeof fetch
  verifyImap?: typeof verifyImapAccount
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

  r.post('/accounts/imap', requireScope('admin'), async (c) => {
    const parsed = ImapAccountInput.safeParse(await c.req.json().catch(() => null))
    if (!parsed.success) {
      return c.json(
        { error: 'bad_request', message: 'Expected an address and TLS logins for IMAP and SMTP' },
        400,
      )
    }
    const { address, ...credentials } = parsed.data
    return deps.sync.withImapPaused(address, async () => {
      try {
        await (deps.verifyImap ?? verifyImapAccount)(credentials)
      } catch {
        return c.json(
          {
            error: 'imap_signin_failed',
            message: 'Could not verify the IMAP and SMTP logins over TLS',
          },
          400,
        )
      }
      try {
        const { id, created } = upsertImapAccount(db, deps.store, deps.sealer, {
          address,
          credentials,
        })
        return c.json({ accountId: id, address, created } satisfies ImapAccountAdded)
      } catch (error) {
        if (error instanceof AccountConflict) {
          return c.json({ error: 'account_conflict', message: error.message }, 409)
        }
        log.error('could not save IMAP Account')
        return c.json(
          { error: 'account_save_failed', message: 'Could not save the IMAP Account' },
          500,
        )
      }
    })
  })

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
      if (error instanceof AccountConflict) {
        return c.json({ error: 'account_conflict', message: error.message }, 409)
      }
      const message =
        error instanceof OAuthError ? error.message : 'Could not complete the Google sign-in'
      log.warn({ err: (error as Error).message }, 'gmail sign-in failed')
      return c.json({ error: 'oauth_failed', message }, 400)
    }
  })

  r.get('/contacts', requireScope('read'), (c) =>
    c.json({
      contacts: searchContacts(db, c.req.query('q') ?? '', intParam(c.req.query('limit')) ?? 10),
    }),
  )

  r.get('/drafts', requireScope('read'), (c) => {
    const threadId = c.req.query('threadId')
    return c.json({ drafts: deps.drafts.list(threadId ? { threadId } : {}) })
  })

  r.post('/drafts', requireScope('draft'), async (c) => {
    try {
      const body = (await c.req.json()) as Parameters<Drafts['create']>[0]
      return c.json(
        await deps.drafts.create(
          body,
          c.get('principal').kind === 'agent' ? c.get('principal').name : 'owner',
        ),
      )
    } catch (error) {
      if (error instanceof DraftError)
        return c.json({ error: 'bad_request', message: error.message }, 400)
      throw error
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
    const html = queries.messageHtml(c.req.param('id'), deps.blobs)
    if (!html) return c.json({ error: 'not_found', message: 'This message has no HTML body' }, 404)
    return c.json({ html })
  })

  r.get('/attachments/:id', requireScope('read'), async (c) => {
    const attachment = await getAttachment(deps, c.req.param('id'))
    if (!attachment) return c.json({ error: 'not_found', message: 'No such attachment' }, 404)
    if (!attachment.hash) {
      return c.json(
        { error: 'unavailable', message: 'Attachment is unavailable from the Account' },
        503,
      )
    }
    const path = deps.blobs.path(attachment.hash)
    const stats = statSync(path, { throwIfNoEntry: false })
    if (!stats) return c.json({ error: 'not_found', message: 'Attachment data is missing' }, 404)
    return c.body(Readable.toWeb(createReadStream(path)) as ReadableStream<Uint8Array>, 200, {
      'Content-Length': String(stats.size),
      'Content-Type': attachment.mime_type,
      'Content-Disposition': `attachment; filename*=UTF-8''${encodeURIComponent(attachment.filename || 'attachment')}`,
      'X-Content-Type-Options': 'nosniff',
    })
  })

  return r
}

/** Fetches uncached attachments through the Account that owns the original message. */
export async function getAttachment(deps: MailDeps, id: string) {
  const { db } = deps
  const row = db
    .prepare(
      `SELECT a.filename, a.mime_type, a.blob, a.provider_attachment, m.provider_id, m.account_id, acc.kind
     FROM attachment a JOIN message m ON m.id = a.message_id
     JOIN account acc ON acc.id = m.account_id WHERE a.id = ?`,
    )
    .get(id) as
    | {
        kind: 'gmail' | 'imap'
        filename: string
        mime_type: string
        blob: string | null
        provider_attachment: string | null
        provider_id: string
        account_id: string
      }
    | undefined
  if (!row) return null
  let hash = row.blob
  if (!hash && row.kind === 'imap') hash = await deps.sync.imapAttachment(row.account_id, id)
  else if (!hash && row.provider_attachment) {
    const api = deps.sync.gmailApi(row.account_id)
    if (api) {
      hash = deps.blobs.put(await api.attachment(row.provider_id, row.provider_attachment))
      db.prepare('UPDATE attachment SET blob = ? WHERE id = ?').run(hash, id)
    }
  }
  return { ...row, hash }
}
