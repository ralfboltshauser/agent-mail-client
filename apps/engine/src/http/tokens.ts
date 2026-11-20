import { SCOPES, type Scope } from '@amc/protocol'
import { Hono } from 'hono'
import { z } from 'zod'
import { issueToken, listTokens, revokeToken } from '../auth/tokens.ts'
import type { Db } from '../db/database.ts'
import { type AppEnv, requireScope } from './app.ts'

const CreateAgentToken = z.object({
  name: z.string().min(1).max(60),
  scopes: z.array(z.enum(SCOPES)).min(1),
  expiresInDays: z.number().int().min(1).max(3650).optional(),
})

/** Agent tokens: created by the owner's CLI or desktop app. Agents never get `admin`. */
export function tokenRoutes(db: Db) {
  const r = new Hono<AppEnv>()

  r.get('/tokens', requireScope('admin'), (c) =>
    c.json({
      tokens: (listTokens(db) as { scopes: string }[]).map((t) => ({
        ...t,
        scopes: JSON.parse(t.scopes) as Scope[],
      })),
    }),
  )

  r.post('/tokens', requireScope('admin'), async (c) => {
    const parsed = CreateAgentToken.safeParse(await c.req.json().catch(() => null))
    if (!parsed.success)
      return c.json({ error: 'bad_request', message: z.prettifyError(parsed.error) }, 400)
    if (parsed.data.scopes.includes('admin')) {
      return c.json(
        { error: 'forbidden', message: 'Agent tokens cannot hold the admin scope' },
        403,
      )
    }
    try {
      const issued = issueToken(db, {
        kind: 'agent',
        name: parsed.data.name,
        scopes: parsed.data.scopes,
        ...(parsed.data.expiresInDays
          ? { expiresAt: Date.now() + parsed.data.expiresInDays * 86_400_000 }
          : {}),
      })
      return c.json({ id: issued.id, token: issued.secret, scopes: issued.scopes })
    } catch (error) {
      return c.json({ error: 'forbidden', message: (error as Error).message }, 403)
    }
  })

  r.delete('/tokens/:id', requireScope('admin'), (c) =>
    revokeToken(db, c.req.param('id'))
      ? c.json({ revoked: c.req.param('id') })
      : c.json({ error: 'not_found', message: 'No such active token' }, 404),
  )

  return r
}
