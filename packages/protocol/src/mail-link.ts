export type MailLink =
  | { kind: 'thread'; threadId: string }
  | { kind: 'draft'; draftId: string }
  | { kind: 'search'; query: string; accountId: string | null }

export type MailLinkDestination = MailLink & { engineOrigin: string }

export const MAIL_LINK_BRIDGE = '/open-mail'
export const MAIL_SEARCH_PAGE_SIZE = 50

// biome-ignore-start lint/suspicious/noControlCharactersInRegex: Native URL targets explicitly reject control characters.
const validId = (value: string) =>
  value.length > 0 && value.length <= 512 && !/[\u0000-\u001f\u007f]/.test(value)
// biome-ignore-end lint/suspicious/noControlCharactersInRegex: Only ID validation needs a control-character range.
const validQuery = (value: string) =>
  value.trim().length > 0 && value.length <= 2000 && !value.includes('\0')

export function mailLink(engineUrl: string, target: MailLink): string {
  const params = new URLSearchParams({ engine: new URL(engineUrl).origin })
  if (target.kind === 'thread')
    return `amc://thread/${encodeURIComponent(target.threadId)}?${params}`
  if (target.kind === 'draft') return `amc://draft/${encodeURIComponent(target.draftId)}?${params}`
  params.set('q', target.query)
  if (target.accountId !== null) params.set('accountId', target.accountId)
  return `amc://search?${params}`
}

export function parseMailLink(value: string): MailLinkDestination | null {
  if (!/^amc:\/\/(?:draft\/|thread\/|search\?)/.test(value) || value.length > 25_000) return null
  try {
    const url = new URL(value)
    if (url.hash || url.username || url.password || url.port) return null
    const params = url.searchParams
    const engineOrigin = params.get('engine') ?? ''
    const engine = new URL(engineOrigin)
    if (
      params.getAll('engine').length !== 1 ||
      !['http:', 'https:'].includes(engine.protocol) ||
      engine.origin !== engineOrigin
    )
      return null
    if (params.size === 1 && /^\/[^/]+$/.test(url.pathname)) {
      const id = decodeURIComponent(url.pathname.slice(1))
      if (!validId(id) || id === '.' || id === '..') return null
      if (url.hostname === 'draft') return { kind: 'draft', draftId: id, engineOrigin }
      if (url.hostname === 'thread') return { kind: 'thread', threadId: id, engineOrigin }
    }
    if (url.hostname !== 'search' || url.pathname) return null
    if ([...params.keys()].some((key) => !['engine', 'q', 'accountId'].includes(key))) return null
    if (params.getAll('q').length !== 1 || params.getAll('accountId').length > 1) return null
    const query = params.get('q') ?? ''
    const accountId = params.get('accountId')
    return validQuery(query) && (accountId === null || validId(accountId))
      ? { kind: 'search', query, accountId, engineOrigin }
      : null
  } catch {
    return null
  }
}

export function mailWebLink(engineUrl: string, target: MailLink): string {
  const url = new URL(MAIL_LINK_BRIDGE, engineUrl)
  url.hash = encodeURIComponent(mailLink(engineUrl, target))
  return url.href
}

export function sameMailEngine(
  target: Pick<MailLinkDestination, 'engineOrigin'>,
  engineUrl: string,
): boolean {
  return target.engineOrigin === new URL(engineUrl).origin
}
