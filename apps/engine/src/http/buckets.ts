import { BucketInput, BucketReviewInput } from '@amc/protocol'
import { Hono } from 'hono'
import { setBucketAsAgent } from '../mail/agent-actions.ts'
import type { MailStore } from '../mail/store.ts'
import { correctBucket, setOwnerBucket } from '../mail/triage/corrections.ts'
import { type AppEnv, requireScope } from './app.ts'

export function bucketRoutes(store: MailStore) {
  const routes = new Hono<AppEnv>()

  routes.put('/bucket', requireScope('organize'), async (c) => {
    const body = await c.req.json().catch(() => null)
    if (body && typeof body === 'object' && 'intent' in body) {
      const review = BucketReviewInput.safeParse(body)
      if (!review.success)
        return c.json({ error: 'bad_request', message: 'Invalid Bucket review intent' }, 400)
      return c.json(correctBucket(store, c.get('principal'), review.data))
    }
    const parsed = BucketInput.safeParse(body)
    if (!parsed.success)
      return c.json(
        {
          error: 'bad_request',
          message: 'Expected a Thread, Bucket (or null), and one-line reason',
        },
        400,
      )
    const principal = c.get('principal')
    if (principal.kind === 'agent') {
      const result = setBucketAsAgent(store, principal, parsed.data)
      if (result.status)
        return c.json(
          { error: result.status === 404 ? 'not_found' : 'rate_limited', message: result.error },
          result.status,
        )
      return c.json({ updated: result.updated })
    }
    if (!setOwnerBucket(store, principal, parsed.data))
      return c.json({ error: 'not_found', message: 'Thread is no longer available' }, 404)
    return c.json({ updated: true })
  })

  return routes
}
