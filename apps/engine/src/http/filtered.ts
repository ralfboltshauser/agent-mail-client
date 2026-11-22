import { AdoptScreenedDestination, FilterReviewInput } from '@amc/protocol'
import { Hono } from 'hono'
import { z } from 'zod'
import type { Mutations } from '../mail/mutations.ts'
import { assertOwner } from '../mail/senders/actions.ts'
import type { MailStore } from '../mail/store.ts'
import { checkOwnerReason } from '../mail/triage/annotations.ts'
import { listFiltered, reviewFilter } from '../mail/triage/filtering.ts'
import { threadInput } from '../mail/triage/input.ts'
import type { AppEnv } from './app.ts'

const ListQuery = z.object({
  accountId: z.string().min(1).max(512).optional(),
  threadId: z.string().min(1).max(512).optional(),
  cursor: z.string().min(1).max(512).optional(),
  limit: z.coerce.number().int().min(1).max(100).default(50),
})

export function filteredRoutes(store: MailStore, queue: Mutations) {
  const routes = new Hono<AppEnv>()
  routes.use('*', async (c, next) => {
    assertOwner(store.db, c.get('principal'))
    await next()
  })
  routes.get('/', (c) => {
    const input = ListQuery.safeParse(c.req.query())
    if (!input.success)
      return c.json({ error: 'bad_request', message: 'Invalid Filtered query' }, 400)
    const { accountId, cursor, limit, threadId } = input.data
    return c.json(listFiltered(store.db, accountId, cursor, limit, threadId))
  })
  routes.post('/destination/adopt', async (c) => {
    const input = AdoptScreenedDestination.safeParse(await c.req.json().catch(() => null))
    if (!input.success) return c.json({ error: 'bad_request', message: 'Invalid destination' }, 400)
    return c.json(
      await queue.adoptScreenedDestination(
        c.get('principal'),
        input.data.accountId,
        input.data.providerId,
        true,
      ),
    )
  })
  routes.post('/decisions', async (c) => {
    const input = FilterReviewInput.safeParse(await c.req.json().catch(() => null))
    if (!input.success)
      return c.json({ error: 'bad_request', message: 'Invalid filter decision' }, 400)
    checkOwnerReason(input.data.reason)
    const thread = threadInput(store.db, input.data.threadId)
    if (thread) await queue.verifyScreeningCapability(thread.account_id, input.data.clientActionId)
    const action = reviewFilter(store, c.get('principal'), input.data)
    queue.kick()
    return c.json(action, action.status === 'pending' ? 202 : 200)
  })
  return routes
}
