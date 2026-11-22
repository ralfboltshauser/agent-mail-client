import { TriageQueueQuery } from '@amc/protocol'
import { Hono } from 'hono'
import type { Db } from '../db/database.ts'
import { triageQueue } from '../mail/triage/queue.ts'
import type { AppEnv } from './app.ts'

export function triageRoutes(db: Db) {
  const routes = new Hono<AppEnv>()
  routes.get('/queue', (c) => {
    const input = TriageQueueQuery.safeParse(c.req.query())
    if (!input.success)
      return c.json({ error: 'bad_request', message: 'Invalid triage queue query' }, 400)
    return c.json(triageQueue(db, input.data))
  })
  return routes
}
