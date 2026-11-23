import { hasScope, MutationBatch, MutationLookup, type MutationResponse } from '@amc/protocol'
import { type Handler, Hono, type MiddlewareHandler } from 'hono'
import { z } from 'zod'
import {
  MutationError,
  MutationPermissionError,
  type Mutations,
  SNOOZE_DISABLED,
} from '../mail/mutations.ts'
import { type AppEnv, requireScope } from './app.ts'

const requireOrganiseClient: MiddlewareHandler<AppEnv> = async (c, next) => {
  const { kind } = c.get('principal')
  if (kind !== 'desktop' && kind !== 'cli')
    return c.json({ error: 'forbidden', message: 'Organise requires a paired owner Client' }, 403)
  await next()
}

const MutationKinds = z.object({
  mutations: z.array(z.object({ action: z.object({ kind: z.string() }) })),
})

export function mutationRoutes(queue: Mutations) {
  const routes = new Hono<AppEnv>()
  const submit: Handler<AppEnv> = async (c) => {
    const body: unknown = await c.req.json().catch(() => null)
    if (!queue.snoozeEnabled) {
      const batch = MutationKinds.safeParse(body)
      if (batch.data?.mutations.some(({ action }) => action.kind === 'unsnooze'))
        return c.json({ error: 'mutation_rejected', message: SNOOZE_DISABLED }, 409)
    }
    const parsed = MutationBatch.safeParse(body)
    if (!parsed.success)
      return c.json({ error: 'bad_request', message: 'Invalid mutation batch' }, 400)
    try {
      const principal = c.get('principal')
      const mutations = queue.submit(
        principal.tokenId,
        parsed.data.mutations,
        hasScope(principal.scopes, 'admin'),
      )
      queue.kick()
      return c.json({ mutations } satisfies MutationResponse)
    } catch (error) {
      if (error instanceof MutationPermissionError)
        return c.json({ error: 'forbidden', message: error.message }, 403)
      if (!(error instanceof MutationError)) throw error
      return c.json({ error: 'mutation_rejected', message: error.message }, 409)
    }
  }
  routes.post('/mutations', requireScope('organize'), requireOrganiseClient, submit)
  routes.post('/mutations/review', requireScope('organize'), requireOrganiseClient, submit)
  routes.post('/mutations/status', requireScope('organize'), requireOrganiseClient, async (c) => {
    const parsed = MutationLookup.safeParse(await c.req.json().catch(() => null))
    if (!parsed.success)
      return c.json({ error: 'bad_request', message: 'Invalid mutation IDs' }, 400)
    const mutations = queue.lookup(c.get('principal').tokenId, parsed.data.ids)
    return c.json({ mutations } satisfies MutationResponse)
  })
  return routes
}
