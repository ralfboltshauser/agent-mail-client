import type { Address, SenderAvatarResolution } from '@amc/protocol'
import { SenderAvatarResolve } from '@amc/protocol'
import { Hono } from 'hono'
import { bodyLimit } from 'hono/body-limit'
import type { Db } from '../db/database.ts'
import type { SenderAvatars } from '../mail/avatars/index.ts'
import { avatarInitials } from '../mail/avatars/initials.ts'
import { normalizeSender } from '../mail/senders/index.ts'
import type { AppEnv } from './app.ts'

type Message = SenderAvatarResolve['messages'][number]
type AlignedEvidence = (message: Message, normalizedDomain: string) => boolean
interface BimiGrant {
  message: Message
  domain: string
  expires: number
}
const MAX_GRANTS = 512

export function senderAvatarRoutes(
  db: Db,
  avatars: SenderAvatars,
  // Gmail and IMAP do not currently expose a trusted aligned verdict in AMC.
  // A provider adapter can supply verified evidence for the exact message here.
  trustedAlignedEvidence: AlignedEvidence = () => false,
) {
  const routes = new Hono<AppEnv>()
  const grants = new Map<string, BimiGrant>()
  const read = db.prepare('SELECT from_json FROM message WHERE id = ? AND account_id = ?')
  const sender = (message: Message) => {
    const row = read.get(message.messageId, message.accountId)
    return row ? { from: JSON.parse(String(row.from_json)) as Address | null } : null
  }

  routes.post('/resolve', bodyLimit({ maxSize: 128 * 1024 }), async (c) => {
    c.header('Cache-Control', 'no-store')
    const input = SenderAvatarResolve.safeParse(await c.req.json().catch(() => null))
    if (!input.success) return c.json({ error: 'invalid_avatar_request' }, 400)
    const rows: SenderAvatarResolution[] = []
    for (const message of input.data.messages) {
      const stored = sender(message)
      if (!stored) continue
      const address = normalizeSender(stored.from?.address)
      const domain = address?.slice(address.lastIndexOf('@') + 1)
      const eligible = !!domain && trustedAlignedEvidence(message, domain)
      let asset: ReturnType<SenderAvatars['resolve']> = null
      if (address) {
        try {
          asset = avatars.resolve(address, eligible)
        } catch {
          /* Initials also cover a cache failure. */
        }
      }
      if (domain && asset?.source === 'bimi') {
        const key = `${c.get('principal').tokenId}:${asset.digest}`
        grants.delete(key)
        grants.set(key, { message, domain, expires: Date.now() + 5 * 60_000 })
        if (grants.size > MAX_GRANTS) {
          const oldest = grants.keys().next().value
          if (oldest) grants.delete(oldest)
        }
      }
      rows.push({
        ...message,
        ...avatarInitials(address ?? '', stored.from?.name),
        source: asset?.source ?? 'initials',
        digest: asset?.digest ?? null,
      })
    }
    return c.json({ rows })
  })

  routes.get('/:digest', (c) => {
    const digest = c.req.param('digest')
    if (!/^[a-f0-9]{64}$/.test(digest)) return c.notFound()
    const key = `${c.get('principal').tokenId}:${digest}`
    const grant = grants.get(key)
    let bimiDomain: string | undefined
    if (grant) {
      const address = normalizeSender(sender(grant.message)?.from?.address)
      if (
        grant.expires > Date.now() &&
        address?.slice(address.lastIndexOf('@') + 1) === grant.domain &&
        trustedAlignedEvidence(grant.message, grant.domain)
      )
        bimiDomain = grant.domain
      else grants.delete(key)
    }
    let png: Uint8Array | null
    try {
      png = avatars.image(digest, bimiDomain)
    } catch {
      return c.notFound()
    }
    if (!png) return c.notFound()
    const etag = `"${digest}"`
    c.header('ETag', etag)
    c.header('Cache-Control', 'private, no-cache')
    c.header('X-Content-Type-Options', 'nosniff')
    if (
      c.req
        .header('If-None-Match')
        ?.split(',')
        .some((tag) => tag.trim() === etag)
    )
      return c.body(null, 304)
    c.header('Content-Type', 'image/png')
    return c.body(Uint8Array.from(png))
  })

  return routes
}
