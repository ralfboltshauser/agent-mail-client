import { SCOPES, type Scope } from '@amc/protocol'
import { Hono } from 'hono'
import { z } from 'zod'
import { DAY_MS, issueToken, listTokens, MAX_AGENT_DAYS, revokeToken } from '../auth/tokens.ts'
import type { Db } from '../db/database.ts'
import { type AppEnv, requireOwnerAdmin } from './app.ts'
import { readJson } from './json.ts'

const CreateAgentToken = z.object({
  name: z.string().min(1).max(60),
  scopes: z.array(z.enum(SCOPES)).min(1),
  expiresInDays: z.number().int().min(1).max(MAX_AGENT_DAYS).optional(),
  accountId: z.string().min(1).max(512).optional(),
  expiresInMinutes: z.number().int().min(1).max(60).optional(),
})

/** Agent tokens: created by the owner's CLI or desktop app. Agents never get `admin`. */
export function tokenRoutes(db: Db) {
  const r = new Hono<AppEnv>()

  r.get('/tokens', requireOwnerAdmin, (c) =>
    c.json({
      tokens: (listTokens(db) as { scopes: string }[]).map((t) => ({
        ...t,
        scopes: JSON.parse(t.scopes) as Scope[],
      })),
    }),
  )

  r.post('/tokens', requireOwnerAdmin, async (c) => {
    const parsed = CreateAgentToken.safeParse(await readJson(c.req))
    if (!parsed.success)
      return c.json({ error: 'bad_request', message: z.prettifyError(parsed.error) }, 400)
    const { expiresInDays, expiresInMinutes } = parsed.data
    if ((expiresInDays === undefined) === (expiresInMinutes === undefined))
      return c.json({ error: 'bad_request', message: 'Choose exactly one expiry unit' }, 400)
    const duration = (expiresInDays ?? 0) * DAY_MS + (expiresInMinutes ?? 0) * 60_000
    if (parsed.data.scopes.includes('admin')) {
      return c.json(
        { error: 'forbidden', message: 'Agent tokens cannot hold the admin scope' },
        403,
      )
    }
    try {
      const now = Date.now()
      const issued = issueToken(
        db,
        {
          kind: 'agent',
          name: parsed.data.name,
          scopes: parsed.data.scopes,
          expiresAt: now + duration,
          ...(parsed.data.accountId ? { accountId: parsed.data.accountId } : {}),
        },
        now,
      )
      return c.json({ id: issued.id, token: issued.secret, scopes: issued.scopes })
    } catch (error) {
      return c.json({ error: 'forbidden', message: (error as Error).message }, 403)
    }
  })

  r.delete('/tokens/:id', requireOwnerAdmin, (c) =>
    revokeToken(db, c.req.param('id'))
      ? c.json({ revoked: c.req.param('id') })
      : c.json({ error: 'not_found', message: 'No such active token' }, 404),
  )

  return r
}
