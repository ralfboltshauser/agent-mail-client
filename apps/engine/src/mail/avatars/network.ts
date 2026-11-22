import { Resolver } from 'node:dns/promises'
import { request } from 'node:https'
import { isIP } from 'node:net'
import ipaddr from 'ipaddr.js'
import { parse } from 'tldts'

import { MAX_INPUT } from './limits.ts'
export class AvatarLookupError extends Error {
  readonly outcome: 'miss' | 'unsafe' | 'transient'
  constructor(outcome: 'miss' | 'unsafe' | 'transient') {
    super(outcome)
    this.outcome = outcome
  }
}

const WEBMAIL_V1 = new Set([
  'gmail.com',
  'googlemail.com',
  'outlook.com',
  'hotmail.com',
  'live.com',
  'msn.com',
  'yahoo.com',
  'icloud.com',
  'me.com',
  'mac.com',
  'aol.com',
  'proton.me',
  'protonmail.com',
])
const excluded = new Set([
  'localhost',
  'local',
  'internal',
  'home.arpa',
  'test',
  'invalid',
  'example',
  'onion',
  'example.com',
  'example.net',
  'example.org',
  'gravatar.com',
  'faviconkit.com',
  'clearbit.com',
])
const suffixMatch = (host: string, names: ReadonlySet<string>) =>
  host.split('.').some((_label, i, labels) => names.has(labels.slice(i).join('.')))

export const isWebmail = (host: string) => suffixMatch(host, WEBMAIL_V1)

export function publicDomain(host: string): string | null {
  if (
    host.length > 253 ||
    isIP(host) ||
    suffixMatch(host, excluded) ||
    !host.split('.').every((label) => /^[a-z0-9](?:[a-z0-9-]{0,61}[a-z0-9])?$/.test(label))
  )
    return null
  const domain = parse(host, { allowPrivateDomains: true, validateHostname: false })
  return domain.isIcann || domain.isPrivate ? domain.domain : null
}

// Conservatively exclude the IANA special-purpose ranges and IPv6 transition space.
const blockedV4 = [
  '0.0.0.0/8',
  '10.0.0.0/8',
  '100.64.0.0/10',
  '127.0.0.0/8',
  '169.254.0.0/16',
  '172.16.0.0/12',
  '192.0.0.0/24',
  '192.0.2.0/24',
  '192.88.99.0/24',
  '192.168.0.0/16',
  '198.18.0.0/15',
  '198.51.100.0/24',
  '203.0.113.0/24',
  '224.0.0.0/3',
].map((block) => ipaddr.IPv4.parseCIDR(block))
const blockedV6 = ['2001::/23', '2001:db8::/32', '2002::/16', '3fff::/20'].map((block) =>
  ipaddr.IPv6.parseCIDR(block),
)
const globalV6 = ipaddr.IPv6.parseCIDR('2000::/3')

export function publicIp(address: string): boolean {
  switch (isIP(address)) {
    case 4: {
      const ip = ipaddr.IPv4.parse(address)
      return ip.range() === 'unicast' && !blockedV4.some((block) => ip.match(block))
    }
    case 6: {
      const ip = ipaddr.IPv6.parse(address)
      return (
        ip.range() === 'unicast' &&
        ip.match(globalV6) &&
        !blockedV6.some((block) => ip.match(block))
      )
    }
    default:
      return false
  }
}

export function bounded<T>(work: Promise<T>, signal: AbortSignal): Promise<T> {
  return new Promise((resolve, reject) => {
    const abort = () => reject(new AvatarLookupError('transient'))
    signal.addEventListener('abort', abort, { once: true })
    if (signal.aborted) abort()
    void work.then(resolve, reject).finally(() => signal.removeEventListener('abort', abort))
  })
}

async function dns<T>(signal: AbortSignal, query: (resolver: Resolver) => Promise<T>): Promise<T> {
  if (signal.aborted) throw new AvatarLookupError('transient')
  const resolver = new Resolver()
  const cancel = () => resolver.cancel()
  signal.addEventListener('abort', cancel, { once: true })
  try {
    return await bounded(query(resolver), signal)
  } finally {
    signal.removeEventListener('abort', cancel)
  }
}

function missing(error: unknown): boolean {
  return ['ENODATA', 'ENOTFOUND'].includes((error as NodeJS.ErrnoException)?.code ?? '')
}

async function addresses(host: string, signal: AbortSignal): Promise<string[]> {
  return dns(signal, async (resolver) => {
    const answers = await Promise.all([
      resolver.resolve4(`${host}.`).catch((error) => {
        if (missing(error)) return []
        throw error
      }),
      resolver.resolve6(`${host}.`).catch((error) => {
        if (missing(error)) return []
        throw error
      }),
    ])
    return answers.flat()
  })
}

export const imageTypes = new Set([
  'image/png',
  'image/jpeg',
  'image/x-icon',
  'image/vnd.microsoft.icon',
  'image/svg+xml',
])
type Reply = { kind: 'redirect'; location: string } | { kind: 'image'; type: string; bytes: Buffer }

interface Network {
  addresses: typeof addresses
  requestImage: typeof requestImage
  txt: (host: string, signal: AbortSignal) => Promise<string[][]>
}

function isAvatarService(url: URL): boolean {
  const host = url.hostname
  const path = url.pathname.toLowerCase()
  return (
    (/(^|\.)google\.com$/.test(host) && path.startsWith('/s2/favicons')) ||
    (/(^|\.)gstatic\.com$/.test(host) && path.startsWith('/favicon')) ||
    (/(^|\.)duckduckgo\.com$/.test(host) && path.startsWith('/ip3/'))
  )
}

function destination(url: URL): string {
  const domain = publicDomain(url.hostname)
  if (
    !domain ||
    url.protocol !== 'https:' ||
    url.port ||
    url.username ||
    url.password ||
    url.hash ||
    isAvatarService(url) ||
    url.href.length > 2048
  )
    throw new AvatarLookupError('unsafe')
  return domain
}

function requestImage(url: URL, address: string, signal: AbortSignal): Promise<Reply> {
  // Connect to the vetted IP directly. Use the DNS name for SNI, certificate checks and Host.
  destination(url)
  if (!publicIp(address)) throw new AvatarLookupError('unsafe')
  return new Promise((resolve, reject) => {
    const req = request(
      {
        hostname: address,
        servername: url.hostname,
        port: 443,
        path: url.pathname + url.search,
        agent: false,
        rejectUnauthorized: true,
        maxHeaderSize: 8192,
        signal,
        headers: {
          Host: url.hostname,
          Accept: [...imageTypes].join(', '),
          'Accept-Encoding': 'identity',
        },
      },
      (res) => {
        void readImage(res)
          .then(resolve, reject)
          .finally(() => res.destroy())
      },
    )
    req.on('error', (error: NodeJS.ErrnoException) => {
      const retryable =
        signal.aborted ||
        [
          'ECONNREFUSED',
          'ECONNRESET',
          'ETIMEDOUT',
          'EHOSTUNREACH',
          'ENETUNREACH',
          'EPIPE',
        ].includes(error.code ?? '')
      reject(new AvatarLookupError(retryable ? 'transient' : 'unsafe'))
    })
    req.end()
  })
}

export async function readImage(
  res: Pick<
    import('node:http').IncomingMessage,
    'statusCode' | 'headers' | typeof Symbol.asyncIterator
  >,
): Promise<Reply> {
  const status = res.statusCode ?? 0
  if ([301, 302, 303, 307, 308].includes(status) && res.headers.location)
    return { kind: 'redirect', location: res.headers.location }
  if (status >= 500 || [408, 425, 429].includes(status)) throw new AvatarLookupError('transient')
  if (status !== 200) throw new AvatarLookupError('miss')
  const type = res.headers['content-type']?.split(';')[0]?.trim().toLowerCase()
  const encoding = res.headers['content-encoding']
  // Reject compressed responses. The counted wire bytes are exactly the decoder input.
  if (
    !type ||
    !imageTypes.has(type) ||
    (encoding && encoding.toLowerCase() !== 'identity') ||
    Number(res.headers['content-length']) > MAX_INPUT
  )
    throw new AvatarLookupError('unsafe')
  const chunks: Buffer[] = []
  let size = 0
  try {
    for await (const chunk of res) {
      size += chunk.length
      if (size > MAX_INPUT) throw new AvatarLookupError('unsafe')
      chunks.push(chunk)
    }
  } catch (error) {
    if (error instanceof AvatarLookupError) throw error
    throw new AvatarLookupError('transient')
  }
  return { kind: 'image', type, bytes: Buffer.concat(chunks, size) }
}

const productionNetwork: Network = {
  addresses,
  requestImage,
  txt: (host, signal) => dns(signal, (resolver) => resolver.resolveTxt(`${host}.`)),
}

export class AvatarNetwork {
  readonly #network: Network
  constructor(network: Network = productionNetwork) {
    this.#network = network
  }

  async bimi(domain: string, signal: AbortSignal): Promise<URL> {
    if (!publicDomain(domain) || isWebmail(domain)) throw new AvatarLookupError('unsafe')
    const txt = await bounded(this.#network.txt(`default._bimi.${domain}`, signal), signal).catch(
      (error) => {
        throw new AvatarLookupError(missing(error) ? 'miss' : 'transient')
      },
    )
    const [record, extra] = txt
      .map((chunks) => chunks.join(''))
      .filter((value) => /^\s*v\s*=\s*BIMI1\b/i.test(value))
    if (!record) throw new AvatarLookupError('miss')
    const match =
      /^v=BIMI1;[ \t]*l=(https:\/\/[^;\s]+)[ \t]*(?:;[ \t]*(?:a=(?:https:\/\/[^;\s]+)?[ \t]*;?[ \t]*)?)?$/.exec(
        record,
      )
    if (extra !== undefined || !match?.[1]) throw new AvatarLookupError('unsafe')
    return parseUrl(match[1])
  }

  async image(
    url: URL,
    faviconDomain: string | null,
    signal: AbortSignal,
  ): Promise<Extract<Reply, { kind: 'image' }>> {
    for (let hop = 0; hop <= 2; hop++) {
      const domain = destination(url)
      if (faviconDomain && domain !== faviconDomain) throw new AvatarLookupError('unsafe')
      const ips = await bounded(this.#network.addresses(url.hostname, signal), signal).catch(
        (error) => {
          throw new AvatarLookupError(missing(error) ? 'miss' : 'transient')
        },
      )
      const ip = ips[0]
      if (!ip) throw new AvatarLookupError('miss')
      if (ips.some((address) => !publicIp(address))) throw new AvatarLookupError('unsafe')
      if (signal.aborted) throw new AvatarLookupError('transient')
      const reply = await bounded(this.#network.requestImage(url, ip, signal), signal)
      if (reply.kind === 'image') return reply
      if (hop === 2) break
      url = parseUrl(reply.location, url)
    }
    throw new AvatarLookupError('unsafe')
  }
}

function parseUrl(value: string, base?: URL): URL {
  // Reject ambiguous forms before URL normalization can discard empty userinfo or fragments.
  if (
    /[\\#]/.test(value) ||
    Array.from(value).some((char) => char.charCodeAt(0) <= 32 || char.charCodeAt(0) === 127) ||
    /^(?:https:\/\/|\/\/)[^/?]*@/i.test(value)
  )
    throw new AvatarLookupError('unsafe')
  try {
    return new URL(value, base)
  } catch {
    throw new AvatarLookupError('unsafe')
  }
}
