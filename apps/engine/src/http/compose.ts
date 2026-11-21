import type { ComposePatch, ComposeStart, SendRequest } from '@amc/protocol'
import { type Context, Hono } from 'hono'
import { bodyLimit } from 'hono/body-limit'
import { HTTPException } from 'hono/http-exception'
import { z } from 'zod'
import { startHandoff } from '../auth/handoff.ts'
import { MAX_ATTACHMENT_BYTES } from '../mail/drafts.ts'
import { type Outbox, requireDesktopSend } from '../mail/outbox.ts'
import { getSetting, setSetting } from '../settings.ts'
import type { AppEnv } from './app.ts'
import { getAttachment, type MailDeps } from './mail.ts'

const id = z.string().min(1).max(512)
const address = z.object({
  address: z.email().max(254),
  name: z.string().max(512).nullable(),
})
const start = z.object({
  accountId: id.optional(),
  threadId: id.optional(),
  mode: z.enum(['new', 'reply', 'reply-all', 'forward']),
})
const edits = z.object({
  update: z.base64().max(2_000_000),
  fields: z
    .object({
      accountId: id,
      to: z.array(address).max(100),
      cc: z.array(address).max(100),
      bcc: z.array(address).max(100),
      subject: z.string().max(998),
      attachmentIds: z.array(id).max(100),
    })
    .optional(),
})
const patch = edits.extend({ baseRevision: z.number().int().nonnegative() })
const send = z.object({
  edits: edits.optional(),
  id,
  draftId: id,
  revision: z.number().int().nonnegative(),
  sendAt: z.number().int().nonnegative().max(8_640_000_000_000_000).optional(),
})
const attachment = z.object({
  filename: z
    .string()
    .min(1)
    .max(255)
    .regex(/^[^\r\n]+$/),
  mimeType: z
    .string()
    .max(200)
    .regex(/^[\w.+-]+\/[\w.+-]+$/),
  inline: z.boolean().optional(),
  content: z.base64().max((MAX_ATTACHMENT_BYTES * 4) / 3),
})

async function body<T>(c: Context<AppEnv>, schema: z.ZodType<T>): Promise<T> {
  const result = schema.safeParse(await c.req.json().catch(() => null))
  if (!result.success) throw new HTTPException(400, { message: 'Invalid compose request' })
  return result.data
}

export function composeRoutes(deps: MailDeps, outbox: Outbox, composerOrigin?: string) {
  const r = new Hono<AppEnv>()
  r.use('*', async (c, next) => {
    requireDesktopSend(c.get('principal'))
    await next()
  })
  r.use('*', bodyLimit({ maxSize: Math.ceil((MAX_ATTACHMENT_BYTES * 4) / 3) + 4096 }))
  r.post('/handoff', async (c) => {
    if (!composerOrigin)
      throw new HTTPException(503, { message: 'Configure the Engine Composer Link origin first' })
    const input = await body(c, z.object({ threadId: id, requestId: z.uuid() }))
    const handoff = await startHandoff(deps.db, deps.drafts, input.threadId, input.requestId)
    const link = new URL(`/compose/${encodeURIComponent(handoff.draftId)}`, composerOrigin)
    link.hash = new URLSearchParams({ token: handoff.composerToken }).toString()
    return c.json(
      { draftId: handoff.draftId, composerUrl: link.href, agentToken: handoff.agentToken },
      201,
      {
        'Cache-Control': 'no-store',
      },
    )
  })
  r.put('/handoff/:id', async (c) => {
    const input = await body(c, z.object({ t3ThreadId: id }))
    const saved = deps.db
      .prepare('UPDATE handoff SET t3_thread_id = ? WHERE id = ?')
      .run(input.t3ThreadId, c.req.param('id'))
    if (!saved.changes) throw new HTTPException(404, { message: 'Handoff does not exist' })
    return c.json({ saved: true })
  })
  r.delete('/handoff/:id', (c) => {
    deps.db.prepare('DELETE FROM handoff WHERE id = ?').run(c.req.param('id'))
    return c.json({ cancelled: true })
  })
  r.post('/drafts', async (c) =>
    c.json(
      await deps.drafts.startCompose(
        await body<ComposeStart>(c, start),
        async (id) => (await getAttachment(deps, id))?.hash ?? null,
      ),
      201,
    ),
  )
  r.get('/drafts', (c) => c.json({ drafts: deps.drafts.list({ limit: 200, editable: true }) }))
  r.get('/drafts/:id', (c) => {
    const draft = deps.drafts.openCompose(c.req.param('id'))
    if (!draft) throw new HTTPException(404, { message: 'Draft does not exist' })
    return c.json(draft)
  })
  r.put('/drafts/:id', async (c) =>
    c.json(deps.drafts.saveCompose(c.req.param('id'), await body<ComposePatch>(c, patch))),
  )
  r.post('/drafts/:id/attachments', async (c) => {
    const part = await body(c, attachment)
    return c.json(
      deps.drafts.addAttachment(
        c.req.param('id'),
        part.filename,
        part.mimeType,
        Buffer.from(part.content, 'base64'),
        part.inline,
      ),
      201,
    )
  })
  r.get('/drafts/:id/inline', (c) => {
    const image = deps.drafts.inlineImage(c.req.param('id'), c.req.query('cid') ?? '')
    if (!image) throw new HTTPException(404, { message: 'Inline image unavailable' })
    return c.json(image)
  })
  r.get('/outbox', (c) => c.json({ items: outbox.list(c.get('principal')) }))
  r.post('/outbox', async (c) => {
    const input = await body<SendRequest>(c, send)
    return c.json(await deps.drafts.prepareSend(input, c.get('principal'), outbox), 202)
  })
  r.post('/outbox/:id/cancel', (c) => {
    if (!outbox.cancel(c.get('principal'), c.req.param('id'))) {
      throw new HTTPException(409, { message: 'This send can no longer be cancelled' })
    }
    return c.json({ cancelled: true })
  })
  r.post('/outbox/:id/resolve', async (c) => {
    const { action } = await body(c, z.object({ action: z.enum(['check', 'reopen']) }))
    const draftId = outbox.resolve(c.get('principal'), c.req.param('id'), action)
    if (!draftId)
      throw new HTTPException(409, { message: 'This send outcome can no longer be changed' })
    return c.json({ draftId })
  })
  r.get('/signature/:id', (c) => c.json({ signature: deps.drafts.signature(c.req.param('id')) }))
  r.put('/signature/:id', async (c) => {
    const { signature } = await body(c, z.object({ signature: z.string().max(5000) }))
    deps.drafts.setSignature(c.req.param('id'), signature)
    return c.json({ signature })
  })
  r.get('/settings', (c) => c.json({ undoSendSeconds: getSetting(deps.db, 'undoSendSeconds') }))
  r.put('/settings', async (c) => {
    const settings = await body(c, z.object({ undoSendSeconds: z.number().int().min(0).max(120) }))
    setSetting(deps.db, 'undoSendSeconds', settings.undoSendSeconds)
    return c.json(settings)
  })
  return r
}
