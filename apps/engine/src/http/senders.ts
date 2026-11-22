import {
  AdoptScreenedDestination,
  OwnerActionReasonInput,
  type OwnerActionStatus,
  SenderDecision,
  SenderListQuery,
} from '@amc/protocol'
import { Hono } from 'hono'
import type { Principal } from '../auth/tokens.ts'
import type { Mutations } from '../mail/mutations.ts'
import {
  assertOwner,
  decideSender,
  listSenders,
  senderActionStatus,
  undoSender,
} from '../mail/senders/actions.ts'
import type { MailStore } from '../mail/store.ts'
import { editOwnerReason } from '../mail/triage/annotations.ts'
import type { AppEnv } from './app.ts'

export interface OwnerActionHandler {
  get(id: string): OwnerActionStatus | Promise<OwnerActionStatus>
  undo(principal: Principal, id: string): OwnerActionStatus | Promise<OwnerActionStatus>
}

export function senderRoutes(store: MailStore, queue: Mutations) {
  const routes = new Hono<AppEnv>()
  routes.use('*', async (c, next) => {
    assertOwner(store.db, c.get('principal'))
    await next()
  })
  routes.get('/', (c) => {
    const parsed = SenderListQuery.safeParse(c.req.query())
    if (!parsed.success)
      return c.json({ error: 'bad_request', message: 'Invalid Sender query' }, 400)
    return c.json(listSenders(store.db, parsed.data))
  })
  routes.post('/decisions', async (c) => {
    const parsed = SenderDecision.safeParse(await c.req.json().catch(() => null))
    if (!parsed.success)
      return c.json({ error: 'bad_request', message: 'Invalid Sender decision' }, 400)
    if (parsed.data.decision === 'block')
      await queue.verifyScreeningCapability(parsed.data.accountId, parsed.data.clientActionId)
    const action = decideSender(store, c.get('principal'), parsed.data)
    queue.kick()
    return c.json(action, action.status === 'pending' ? 202 : 200)
  })
  routes.post('/destination/adopt', async (c) => {
    const parsed = AdoptScreenedDestination.safeParse(await c.req.json().catch(() => null))
    if (!parsed.success)
      return c.json({ error: 'bad_request', message: 'Invalid destination' }, 400)
    return c.json(
      await queue.adoptScreenedDestination(
        c.get('principal'),
        parsed.data.accountId,
        parsed.data.providerId,
        parsed.data.destination === 'filtered',
      ),
    )
  })
  return routes
}

export function ownerActionRoutes(
  store: MailStore,
  queue: Mutations,
  extensions: Readonly<Record<string, OwnerActionHandler>> = {},
) {
  const routes = new Hono<AppEnv>()
  const sender: OwnerActionHandler = {
    get: (id) => senderActionStatus(store.db, id),
    undo(principal, id) {
      const action = undoSender(store, principal, id)
      queue.kick()
      return action
    },
  }
  const handler = (id: string) => {
    const row = store.db.prepare('SELECT kind FROM owner_action WHERE id = ?').get(id)
    return row && (String(row.kind).startsWith('sender:') ? sender : extensions[String(row.kind)])
  }
  routes.use('*', async (c, next) => {
    assertOwner(store.db, c.get('principal'))
    await next()
  })
  routes.get('/:id', async (c) => {
    const id = c.req.param('id')
    const owner = handler(id)
    if (!owner) return c.json({ error: 'not_found', message: 'Owner action unavailable' }, 404)
    return c.json(await owner.get(id))
  })
  routes.put('/:id/reason', async (c) => {
    const id = c.req.param('id')
    const input = OwnerActionReasonInput.safeParse(await c.req.json().catch(() => null))
    if (!input.success)
      return c.json(
        { error: 'bad_request', message: 'Use a single-line reason of at most 500 characters' },
        400,
      )
    const principal = c.get('principal')
    assertOwner(store.db, principal)
    if (!editOwnerReason(store.db, id, input.data.reason))
      return c.json({ error: 'not_found', message: 'Owner action unavailable' }, 404)
    return c.json({ reason: input.data.reason || null })
  })
  routes.post('/:id/undo', async (c) => {
    const id = c.req.param('id')
    const owner = handler(id)
    if (!owner) return c.json({ error: 'not_found', message: 'Owner action unavailable' }, 404)
    const action = await owner.undo(c.get('principal'), id)
    return c.json(action, action.undo?.status === 'pending' ? 202 : 200)
  })
  return routes
}
