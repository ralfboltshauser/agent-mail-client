export type MailLink =
  | { kind: 'thread'; threadId: string }
  | { kind: 'search'; query: string; accountId: string | null }

export const MAIL_LINK_BRIDGE = '/open-mail'
export const MAIL_SEARCH_PAGE_SIZE = 50

// biome-ignore-start lint/suspicious/noControlCharactersInRegex: Native URL targets explicitly reject control characters.
const validId = (value: string) =>
  value.length > 0 && value.length <= 512 && !/[\u0000-\u001f\u007f]/.test(value)
// biome-ignore-end lint/suspicious/noControlCharactersInRegex: Only ID validation needs a control-character range.
const validQuery = (value: string) =>
  value.trim().length > 0 && value.length <= 2000 && !value.includes('\0')

export function mailLink(target: MailLink): string {
  if (target.kind === 'thread') return `amc://thread/${encodeURIComponent(target.threadId)}`
  const params = new URLSearchParams({ q: target.query })
  if (target.accountId !== null) params.set('accountId', target.accountId)
  return `amc://search?${params}`
}

export function parseMailLink(value: string): MailLink | null {
  if (!/^amc:\/\/(?:thread\/|search\?)/.test(value) || value.length > 25_000) return null
  try {
    const url = new URL(value)
    if (url.hash || url.username || url.password || url.port) return null
    if (url.hostname === 'thread' && !url.search && /^\/[^/]+$/.test(url.pathname)) {
      const threadId = decodeURIComponent(url.pathname.slice(1))
      return validId(threadId) && threadId !== '.' && threadId !== '..'
        ? { kind: 'thread', threadId }
        : null
    }
    if (url.hostname !== 'search' || url.pathname) return null
    const params = url.searchParams
    if ([...params.keys()].some((key) => key !== 'q' && key !== 'accountId')) return null
    if (params.getAll('q').length !== 1 || params.getAll('accountId').length > 1) return null
    const query = params.get('q') ?? ''
    const accountId = params.get('accountId')
    return validQuery(query) && (accountId === null || validId(accountId))
      ? { kind: 'search', query, accountId }
      : null
  } catch {
    return null
  }
}

export function mailWebLink(engineUrl: string, target: MailLink): string {
  const url = new URL(MAIL_LINK_BRIDGE, engineUrl)
  url.hash = encodeURIComponent(mailLink(target))
  return url.href
}
