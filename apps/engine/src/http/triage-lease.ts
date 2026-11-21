import { Hono } from 'hono'
import { z } from 'zod'
import type { Db } from '../db/database.ts'
import { type AppEnv, requireOwnerAdmin } from './app.ts'

const Lease = z.object({ holder: z.string().min(1).max(60) })
const TTL = 10 * 60_000

export function triageLeaseRoutes(db: Db) {
  const routes = new Hono<AppEnv>()
  routes.post('/', requireOwnerAdmin, async (c) => {
    const parsed = Lease.safeParse(await c.req.json().catch(() => null))
    if (!parsed.success) return c.json({ error: 'bad_request', message: 'Expected holder' }, 400)

    const now = Date.now()
    const result = db
      .prepare(`
        INSERT INTO triage_lease (slot, holder, expires_at) VALUES (1, ?, ?)
        ON CONFLICT (slot) DO UPDATE SET holder = excluded.holder, expires_at = excluded.expires_at
        WHERE triage_lease.expires_at <= ?
      `)
      .run(parsed.data.holder, now + TTL, now)
    return c.json({ granted: Number(result.changes) === 1 })
  })

  routes.delete('/', requireOwnerAdmin, async (c) => {
    const parsed = Lease.safeParse(await c.req.json().catch(() => null))
    if (!parsed.success) return c.json({ error: 'bad_request', message: 'Expected holder' }, 400)

    db.prepare('DELETE FROM triage_lease WHERE slot = 1 AND holder = ?').run(parsed.data.holder)
    return c.body(null, 204)
  })
  return routes
}
