import {
  BucketByIdInput,
  BucketByIdReviewInput,
  BucketInput,
  BucketReviewInput,
  CreateBucket,
  CustomBucketId,
  OwnerBucketByIdInput,
  OwnerBucketInput,
  ReorderBuckets,
  UpdateBucket,
} from '@amc/protocol'
import { Hono } from 'hono'
import { setBucketAsAgent } from '../mail/agent-actions.ts'
import { createBucket, readCatalog, reorderBuckets, updateBucket } from '../mail/bucket-catalog.ts'
import type { MailStore } from '../mail/store.ts'
import { correctBucket, setOwnerBucket } from '../mail/triage/corrections.ts'
import { type AppEnv, requireOwnerAdmin, requireScope } from './app.ts'
import { readJson } from './json.ts'

export function bucketRoutes(store: MailStore) {
  const routes = new Hono<AppEnv>()

  routes.get('/buckets', requireOwnerAdmin, (c) => c.json(readCatalog(store.db)))
  routes.post('/buckets', requireOwnerAdmin, async (c) => {
    const parsed = CreateBucket.safeParse(await readJson(c.req))
    if (!parsed.success)
      return c.json({ error: 'bad_request', message: parsed.error.issues[0]?.message }, 400)
    return c.json(createBucket(store, c.get('principal'), parsed.data), 201)
  })
  routes.put('/buckets/order', requireOwnerAdmin, async (c) => {
    const parsed = ReorderBuckets.safeParse(await readJson(c.req))
    if (!parsed.success)
      return c.json({ error: 'bad_request', message: parsed.error.issues[0]?.message }, 400)
    return c.json(reorderBuckets(store, c.get('principal'), parsed.data))
  })
  routes.patch('/buckets/:id', requireOwnerAdmin, async (c) => {
    const id = CustomBucketId.safeParse(c.req.param('id'))
    const parsed = UpdateBucket.safeParse(await readJson(c.req))
    if (!id.success || !parsed.success)
      return c.json(
        {
          error: 'bad_request',
          message: !parsed.success
            ? parsed.error.issues[0]?.message
            : 'Expected a custom Bucket ID',
        },
        400,
      )
    return c.json(updateBucket(store, c.get('principal'), id.data, parsed.data))
  })

  routes.put('/bucket', requireScope('organize'), async (c) => {
    const body = await readJson(c.req)
    const byId = body && typeof body === 'object' && 'bucketId' in body
    if (body && typeof body === 'object' && 'intent' in body) {
      const review = (byId ? BucketByIdReviewInput : BucketReviewInput).safeParse(body)
      if (!review.success)
        return c.json({ error: 'bad_request', message: 'Invalid Bucket review intent' }, 400)
      return c.json(correctBucket(store, c.get('principal'), review.data))
    }
    const principal = c.get('principal')
    const parsed = (
      principal.kind === 'agent'
        ? byId
          ? BucketByIdInput
          : BucketInput
        : byId
          ? OwnerBucketByIdInput
          : OwnerBucketInput
    ).safeParse(body)
    if (!parsed.success)
      return c.json(
        {
          error: 'bad_request',
          message: 'Expected a Thread, Bucket (or null), and one-line reason',
        },
        400,
      )
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
