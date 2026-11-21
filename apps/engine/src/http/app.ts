import { existsSync, statfsSync } from 'node:fs'
import type { Health, Me, PublicHealth, Scope } from '@amc/protocol'
import { hasScope, PairRequest } from '@amc/protocol'
import { WebStandardStreamableHTTPServerTransport } from '@modelcontextprotocol/sdk/server/webStandardStreamableHttp.js'
import { Hono, type MiddlewareHandler } from 'hono'
import { HTTPException } from 'hono/http-exception'
import {
  authenticate,
  invalidTokenMessage,
  type Principal,
  redeemPairingCode,
} from '../auth/tokens.ts'
import { type Config, databasePath, listensOnLoopback } from '../config.ts'
import { latestBackup } from '../db/backups.ts'
import { type Db, fileSize, schemaVersion } from '../db/database.ts'
import type { Logger } from '../log.ts'
import { DraftError } from '../mail/drafts.ts'
import type { Mutations } from '../mail/mutations.ts'
import type { Outbox } from '../mail/outbox.ts'
import { buildMcpServer } from '../mcp/server.ts'
import { VERSION } from '../version.ts'
import { agentActionRoutes } from './agent-actions.ts'
import { bucketRoutes } from './buckets.ts'
import { composeRoutes } from './compose.ts'
import { composerLinkRoutes } from './composer-link.ts'
import { type MailDeps, mailRoutes } from './mail.ts'
import { mutationRoutes } from './mutations.ts'
import { syncRoutes } from './sync.ts'
import { tokenRoutes } from './tokens.ts'
import { triageLeaseRoutes } from './triage-lease.ts'

export interface AppEnv {
  Variables: { principal: Principal }
}

export interface AppDeps {
  db: Db
  config: Config
  log: Logger
  startedAt?: number
  mail?: MailDeps
  mutations?: Mutations
  outbox?: Outbox
  composerScript?: () => Promise<string>
}

export function createApp({
  db,
  config,
  log,
  startedAt = Date.now(),
  mail,
  mutations,
  outbox,
  composerScript,
}: AppDeps) {
  const app = new Hono<AppEnv>()

  app.onError((error, c) => {
    if (error instanceof DraftError)
      return c.json({ error: 'draft', message: error.message }, error.status)
    if (error instanceof HTTPException) {
      return c.json({ error: error.message || 'error', message: error.message }, error.status)
    }
    log.error({ err: error, path: c.req.path }, 'unhandled error')
    return c.json({ error: 'internal', message: 'Something went wrong in the Engine' }, 500)
  })

  // Requests through `tailscale serve` carry the tailnet login; refuse anyone not allowed.
  app.use('*', async (c, next) => {
    const login = listensOnLoopback(config) ? c.req.header('Tailscale-User-Login') : undefined
    if (login !== undefined && config.allowedTailscaleLogins.length > 0) {
      if (!config.allowedTailscaleLogins.includes(login)) {
        log.warn({ login, path: c.req.path }, 'refused tailnet login')
        return c.json({ error: 'forbidden', message: 'This tailnet login may not use AMC' }, 403)
      }
    }
    await next()
  })

  app.get('/health', (c) => c.json({ ok: true, version: VERSION } satisfies PublicHealth))

  app.post('/v1/auth/pair', async (c) => {
    const parsed = PairRequest.safeParse(await c.req.json().catch(() => null))
    if (!parsed.success)
      return c.json({ error: 'bad_request', message: 'Expected code and deviceName' }, 400)
    const issued = redeemPairingCode(db, parsed.data.code, parsed.data.deviceName)
    if (!issued) {
      log.warn('pairing refused')
      return c.json(
        { error: 'invalid_code', message: 'Unknown, used or expired pairing code' },
        401,
      )
    }
    log.info({ tokenId: issued.id, kind: issued.kind }, 'paired a device')
    return c.json({ token: issued.secret, kind: issued.kind, scopes: issued.scopes })
  })

  const v1 = new Hono<AppEnv>()
  v1.use('*', requireAuth(db))
  v1.use('*', async (c, next) => {
    const principal = c.get('principal')
    if (principal.kind === 'composer' || principal.threadId)
      return c.json({ error: 'forbidden', message: 'This token cannot use the mail API' }, 403)
    await next()
  })

  v1.get('/me', (c) => {
    const p = c.get('principal')
    return c.json({
      tokenId: p.tokenId,
      kind: p.kind,
      name: p.name,
      scopes: p.scopes,
      features: config.features,
    } satisfies Me)
  })

  v1.get('/health', requireScope('read'), (c) => {
    const dbPath = databasePath(config)
    const now = Date.now()
    const accounts = db
      .prepare('SELECT address, status, last_sync_at, last_error FROM account ORDER BY address')
      .all() as {
      address: string
      status: NonNullable<Health['accounts']>[number]['status']
      last_sync_at: number | null
      last_error: string | null
    }[]
    const pending = db
      .prepare("SELECT count(*) AS depth FROM mutation WHERE status = 'pending'")
      .get()
    const unsent = db
      .prepare("SELECT count(*) AS depth FROM outbox WHERE status IN ('queued', 'dispatching')")
      .get()
    const disks = new Set([config.dataDir, config.blobDir])
    if (existsSync(config.backupDir)) disks.add(config.backupDir)
    const health: Health = {
      ok: true,
      version: VERSION,
      uptimeSeconds: Math.round((now - startedAt) / 1000),
      schemaVersion: schemaVersion(db),
      database: { path: dbPath, bytes: fileSize(dbPath) + fileSize(`${dbPath}-wal`) },
      lastBackup: latestBackup(config.backupDir),
      accounts: accounts.map(({ address, status, last_sync_at, last_error }) => ({
        address,
        status,
        syncLagSeconds: last_sync_at === null ? null : Math.max(0, (now - last_sync_at) / 1000),
        lastError: last_error,
      })),
      outboxDepth: Number(unsent?.depth),
      mutationQueueDepth: Number(pending?.depth),
      disks: [...disks].map((path) => {
        const s = statfsSync(path)
        return { path, freeBytes: s.bavail * s.bsize, totalBytes: s.blocks * s.bsize }
      }),
    }
    return c.json(health)
  })

  v1.route('/', tokenRoutes(db))
  v1.route('/triage/lease', triageLeaseRoutes(db))
  if (mutations) {
    v1.route('/', mutationRoutes(mutations))
    v1.route('/', agentActionRoutes(db, mutations))
  }
  if (mail) {
    app.route('/compose', composerLinkRoutes(db, mail.drafts, config, composerScript))
    if (outbox)
      v1.route(
        '/compose',
        composeRoutes(mail, outbox, listensOnLoopback(config) ? config.composerOrigin : undefined),
      )
    v1.route('/', mailRoutes(mail))
    v1.route('/', bucketRoutes(mail.store))
    v1.route('/', syncRoutes(mail, mutations))

    // MCP over Streamable HTTP, stateless: one server per request, built from the token's scopes.
    app.all('/mcp', requireAuth(db), async (c) => {
      if (c.get('principal').kind === 'composer') return c.json({ error: 'forbidden' }, 403)
      const server = buildMcpServer(c.get('principal'), {
        db,
        store: mail.store,
        queries: mail.queries,
        drafts: mail.drafts,
        mutations,
      })
      const transport = new WebStandardStreamableHTTPServerTransport({
        sessionIdGenerator: undefined,
        enableJsonResponse: true,
      })
      await server.connect(transport)
      return transport.handleRequest(c.req.raw)
    })
  }
  app.route('/v1', v1)
  app.notFound((c) => c.json({ error: 'not_found', message: 'No such route' }, 404))
  return app
}

export function requireAuth(db: Db): MiddlewareHandler<AppEnv> {
  return async (c, next) => {
    const header = c.req.header('Authorization') ?? ''
    const secret = header.startsWith('Bearer ') ? header.slice(7).trim() : ''
    const principal = secret ? authenticate(db, secret) : null
    if (!principal) {
      return c.json({ error: 'unauthorized', message: invalidTokenMessage(db, secret) }, 401)
    }
    c.set('principal', principal)
    await next()
  }
}

export function requireScope(scope: Scope): MiddlewareHandler<AppEnv> {
  return async (c, next) => {
    if (!hasScope(c.get('principal').scopes, scope)) {
      return c.json({ error: 'forbidden', message: `This token lacks the ${scope} scope` }, 403)
    }
    await next()
  }
}

export const requireOwnerAdmin: MiddlewareHandler<AppEnv> = async (c, next) => {
  const { kind, scopes } = c.get('principal')
  if ((kind !== 'desktop' && kind !== 'cli') || !hasScope(scopes, 'admin'))
    return c.json(
      { error: 'forbidden', message: 'This action requires a paired owner Client' },
      403,
    )
  await next()
}
