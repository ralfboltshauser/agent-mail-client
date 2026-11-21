import { MutationBatch, MutationLookup, type MutationResponse } from '@amc/protocol'
import { Hono } from 'hono'
import { MutationError, type Mutations } from '../mail/mutations.ts'
import { type AppEnv, requireScope } from './app.ts'

export function mutationRoutes(queue: Mutations) {
  const routes = new Hono<AppEnv>()
  routes.post('/mutations', requireScope('organize'), async (c) => {
    const parsed = MutationBatch.safeParse(await c.req.json().catch(() => null))
    if (!parsed.success)
      return c.json({ error: 'bad_request', message: 'Invalid mutation batch' }, 400)
    try {
      const mutations = queue.submit(c.get('principal').tokenId, parsed.data.mutations)
      queue.kick()
      return c.json({ mutations } satisfies MutationResponse)
    } catch (error) {
      if (!(error instanceof MutationError)) throw error
      return c.json({ error: 'mutation_rejected', message: error.message }, 409)
    }
  })
  routes.post('/mutations/status', requireScope('organize'), async (c) => {
    const parsed = MutationLookup.safeParse(await c.req.json().catch(() => null))
    if (!parsed.success)
      return c.json({ error: 'bad_request', message: 'Invalid mutation IDs' }, 400)
    const mutations = queue.lookup(c.get('principal').tokenId, parsed.data.ids)
    return c.json({ mutations } satisfies MutationResponse)
  })
  return routes
}
