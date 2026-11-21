import { Hono } from 'hono'
import { authenticate } from '../auth/tokens.ts'
import { type Config, listensOnLoopback } from '../config.ts'
import type { Db } from '../db/database.ts'
import { DraftError, type Drafts } from '../mail/drafts.ts'

export const COMPOSER_WS = '/compose/ws'

export function allowedComposerLogin(config: Config, login: string | null | undefined): boolean {
  if (!listensOnLoopback(config)) return false
  return config.allowedTailscaleLogins.length === 0
    ? Boolean(config.composerOrigin?.startsWith('http://'))
    : Boolean(login && config.allowedTailscaleLogins.includes(login))
}

export function composerDraft(db: Db, drafts: Drafts, id: string, token: string) {
  const principal = authenticate(db, token)
  if (
    principal?.kind !== 'composer' ||
    principal.subject !== id ||
    !principal.scopes.includes('draft')
  )
    return null
  try {
    return drafts.openCompose(id)
  } catch (error) {
    if (error instanceof DraftError) return null
    throw error
  }
}

export function composerLinkRoutes(
  db: Db,
  drafts: Drafts,
  config: Config,
  script?: () => Promise<string>,
) {
  const r = new Hono()
  const origin = config.composerOrigin
  if (!origin) return r
  const websocket = new URL(COMPOSER_WS, origin)
  websocket.protocol = websocket.protocol === 'https:' ? 'wss:' : 'ws:'

  r.use('*', async (c, next) => {
    c.header('Cache-Control', 'no-store')
    c.header('Referrer-Policy', 'no-referrer')
    c.header('X-Content-Type-Options', 'nosniff')
    c.header(
      'Content-Security-Policy',
      `default-src 'none'; script-src 'self'; style-src 'self'; connect-src 'self' ${websocket}; frame-ancestors 'none'; base-uri 'none'; form-action 'none'`,
    )
    if (!allowedComposerLogin(config, c.req.header('Tailscale-User-Login')))
      return c.text('Forbidden', 403)
    await next()
  })
  r.get('/assets/editor.js', async (c) => {
    if (!script) return c.notFound()
    return c.body(await script(), 200, { 'Content-Type': 'text/javascript; charset=utf-8' })
  })
  r.get('/assets/editor.css', (c) =>
    c.body(
      `html{color-scheme:light dark}body{margin:2rem auto;padding:0 1rem;max-width:44rem;font:16px/1.5 system-ui,sans-serif}h1{font-size:1.35rem}#status{min-height:1.5em}.tiptap{min-height:16rem;border:1px solid GrayText;border-radius:.4rem;padding:1rem;white-space:pre-wrap;overflow-wrap:anywhere}.tiptap>:first-child{margin-top:0}.tiptap:focus-visible{outline:2px solid Highlight}`,
      200,
      { 'Content-Type': 'text/css; charset=utf-8' },
    ),
  )
  r.get('/:id', (c) =>
    c.html(`<!doctype html>
<html lang="en"><meta charset="utf-8"><meta name="viewport" content="width=device-width, initial-scale=1">
<title>AMC Composer Link</title><link rel="stylesheet" href="/compose/assets/editor.css">
<h1>Reply draft</h1><p id="status" role="status">Checking Composer Link…</p><main id="editor"></main>
<script type="module" src="/compose/assets/editor.js"></script></html>`),
  )
  // URL fragments never reach the Engine. The public shell contains no draft data.
  r.post('/:id/session', (c) => {
    const authorization = c.req.header('Authorization') ?? ''
    if (
      c.req.header('Origin') !== origin ||
      !authorization.startsWith('Bearer ') ||
      !composerDraft(db, drafts, c.req.param('id'), authorization.slice(7))
    ) {
      return c.text('Invalid or expired Composer Link', 403)
    }
    return c.body(null, 204)
  })
  return r
}
