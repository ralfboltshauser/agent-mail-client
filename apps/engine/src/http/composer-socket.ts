import type { Server } from 'node:http'
import { Hocuspocus } from '@hocuspocus/server'
import { WebSocketServer } from 'ws'
import * as Y from 'yjs'
import type { Config } from '../config.ts'
import type { Db } from '../db/database.ts'
import { DraftError, type Drafts } from '../mail/drafts.ts'
import { allowedComposerLogin, COMPOSER_WS, composerDraft } from './composer-link.ts'

const ACCESS_ENDED = { code: 4403, reason: 'Composer Link is no longer available' }
const MAX_UPDATE = 1_500_000

export function serveComposerSocket(server: Server, config: Config, db: Db, drafts: Drafts) {
  const origin = config.composerOrigin
  if (!origin) return () => {}
  const sockets = new WebSocketServer({ noServer: true, maxPayload: MAX_UPDATE + 1024 })
  const hocuspocus = new Hocuspocus<{ token: string }>({
    quiet: true,
    authenticationTimeout: 5000,
    maxPendingDocuments: 1,
    async onAuthenticate({ documentName, token }) {
      if (!composerDraft(db, drafts, documentName, token)) throw ACCESS_ENDED
      return { token }
    },
    async onLoadDocument({ documentName, context }) {
      const draft = composerDraft(db, drafts, documentName, context.token)
      if (!draft) throw ACCESS_ENDED
      const doc = new Y.Doc()
      Y.applyUpdate(doc, Buffer.from(draft.update, 'base64'))
      return doc
    },
    async beforeHandleMessage({ documentName, context }) {
      if (!composerDraft(db, drafts, documentName, context.token)) throw ACCESS_ENDED
    },
    async beforeSync({ documentName, context, type, payload, document }) {
      const draft = composerDraft(db, drafts, documentName, context.token)
      if (!draft) throw ACCESS_ENDED
      // Yjs sync step 2 and incremental updates both carry client edits. Commit before
      // Hocuspocus applies or broadcasts them and during the same turn as authorization.
      if (type === 1 || type === 2) {
        if (payload.byteLength > MAX_UPDATE)
          throw { code: 4400, reason: 'Draft update is too large' }
        try {
          drafts.saveCompose(
            documentName,
            {
              baseRevision: draft.revision,
              update: Buffer.from(payload).toString('base64'),
            },
            'Composer Link',
          )
        } catch (error) {
          throw {
            code: 4400,
            reason:
              error instanceof DraftError && error.status === 409
                ? error.message
                : 'Draft update was refused',
          }
        }
      }
      Y.applyUpdate(document, Buffer.from(draft.update, 'base64'))
    },
  })

  server.on('upgrade', (req, socket, head) => {
    const login = req.headers['tailscale-user-login']
    if (
      req.url !== COMPOSER_WS ||
      req.headers.origin !== origin ||
      !allowedComposerLogin(config, typeof login === 'string' ? login : null)
    ) {
      socket.end('HTTP/1.1 403 Forbidden\r\nConnection: close\r\n\r\n')
      return
    }
    const headers = new Headers()
    for (const [name, value] of Object.entries(req.headers)) {
      if (typeof value === 'string') headers.set(name, value)
    }
    sockets.handleUpgrade(req, socket, head, (ws) => {
      const connection = hocuspocus.handleConnection(
        ws,
        new Request(new URL(COMPOSER_WS, origin), { headers }),
      )
      ws.on('message', (message, binary) => {
        if (!binary || !Buffer.isBuffer(message)) {
          ws.close(4400, 'Expected a binary composer message')
          return
        }
        connection.handleMessage(message)
      })
      ws.on('pong', () => connection.touch())
      ws.on('error', () => ws.terminate())
      ws.on('close', (code, reason) => connection.handleClose({ code, reason: reason.toString() }))
    })
  })

  // Read committed Engine changes, including desktop writes, MCP edits and Outbox transitions.
  const timer = setInterval(() => {
    for (const [id, document] of hocuspocus.documents) {
      let update: string | undefined
      for (const connection of document.getConnections()) {
        const draft = composerDraft(db, drafts, id, connection.context.token)
        if (draft) update = draft.update
        else connection.webSocket.close(ACCESS_ENDED.code, ACCESS_ENDED.reason)
      }
      if (update) Y.applyUpdate(document, Buffer.from(update, 'base64'))
    }
  }, 500).unref()
  const heartbeat = setInterval(() => {
    for (const ws of sockets.clients) ws.ping()
  }, 15_000).unref()
  return () => {
    clearInterval(heartbeat)
    clearInterval(timer)
    for (const ws of sockets.clients) ws.terminate()
    sockets.close()
  }
}
