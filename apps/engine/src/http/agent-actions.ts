import { Hono } from 'hono'
import { z } from 'zod'
import type { Db } from '../db/database.ts'
import { listAgentActions } from '../mail/agent-actions.ts'
import { MutationError, type Mutations } from '../mail/mutations.ts'
import { type AppEnv, requireOwnerAdmin } from './app.ts'

export function agentActionRoutes(db: Db, queue: Mutations) {
  const routes = new Hono<AppEnv>()
  routes.use('/agent/log/*', requireOwnerAdmin)
  routes.get('/agent/log', (c) => {
    const before = c.req.query('before')
    const cursor = z.coerce.number().int().positive().optional().safeParse(before)
    if (!cursor.success) return c.json({ error: 'bad_request', message: 'Invalid log cursor' }, 400)
    return c.json(listAgentActions(db, queue, cursor.data))
  })
  routes.post('/agent/log/:id/undo', (c) => {
    const id = z.uuid().safeParse(c.req.param('id'))
    if (!id.success) return c.json({ error: 'bad_request', message: 'Invalid action ID' }, 400)
    try {
      const mutations = queue.undoAgentAction(c.get('principal').tokenId, id.data)
      queue.kick()
      return c.json({ mutations })
    } catch (error) {
      if (!(error instanceof MutationError)) throw error
      return c.json({ error: 'mutation_rejected', message: error.message }, 409)
    }
  })
  return routes
}
