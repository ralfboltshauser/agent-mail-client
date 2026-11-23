import { createHash } from 'node:crypto'
import type { Logger } from '../../log.ts'
import { AvatarLookupError, AvatarNetwork, isWebmail, publicDomain } from './network.ts'
import { rasterize } from './raster.ts'
import type { AvatarIndex, CacheEntry } from './store.ts'

export type AvatarSource = 'bimi' | 'favicon'
export interface AvatarAsset {
  digest: string
  png: Uint8Array
}
export type LookupOutcome = 'ready' | 'miss' | 'unsafe' | 'transient'

const MINUTE = 60_000
const DAY = 24 * 60 * MINUTE
const POSITIVE_TTL = 7 * DAY
const MAX_PENDING = 128
const CONCURRENCY = 4
const LOOKUP_BUDGET = 4_000

interface Job {
  domain: string
  pending: Set<AvatarSource>
  inProgress?: AvatarSource
}

export class SenderAvatars {
  readonly #jobs = new Map<string, Job>()
  readonly #queue: Job[] = []
  #running = 0

  readonly #index: AvatarIndex
  readonly #log: Logger
  readonly #network: AvatarNetwork
  readonly #decode: typeof rasterize
  readonly #now: () => number
  readonly #enabled: boolean
  readonly #shutdown?: AbortSignal

  constructor(
    index: AvatarIndex,
    log: Logger,
    options: {
      network?: AvatarNetwork
      decode?: typeof rasterize
      now?: () => number
      enabled?: boolean
      shutdown?: AbortSignal
    } = {},
  ) {
    this.#index = index
    this.#log = log
    this.#network = options.network ?? new AvatarNetwork()
    this.#decode = options.decode ?? rasterize
    this.#now = options.now ?? Date.now
    this.#enabled = options.enabled ?? true
    this.#shutdown = options.shutdown
  }

  resolve(
    address: string,
    trustedAlignedEvidence: boolean,
  ): { digest: string; source: AvatarSource } | null {
    if (!this.#enabled || this.#shutdown?.aborted) return null
    const domain = address.slice(address.lastIndexOf('@') + 1)
    if (isWebmail(domain) || !publicDomain(domain)) return null

    if (trustedAlignedEvidence) {
      const bimi = this.#source(domain, 'bimi')
      if (bimi) return { digest: bimi.digest, source: 'bimi' }
      // An unresolved BIMI gets first use of the lookup budget. A cached favicon can
      // still render while that lookup runs.
      const job = this.#jobs.get(domain)
      if (job?.pending.has('bimi') || job?.inProgress === 'bimi') {
        const favicon = this.#index.get(domain, 'favicon')
        return favicon?.asset && favicon.serveUntil > this.#now()
          ? { digest: favicon.asset.digest, source: 'favicon' }
          : null
      }
    }
    const favicon = this.#source(domain, 'favicon')
    return favicon ? { digest: favicon.digest, source: 'favicon' } : null
  }

  image(digest: string, bimiDomain?: string): Uint8Array | null {
    if (!this.#enabled) return null
    return this.#index.image(digest, this.#now(), bimiDomain)
  }

  #source(domain: string, source: AvatarSource): AvatarAsset | null {
    const entry = this.#index.get(domain, source)
    const now = this.#now()
    if (!entry || entry.retryAt <= now) this.#schedule(domain, source)
    return entry?.asset && entry.serveUntil > now ? entry.asset : null
  }

  #schedule(domain: string, source: AvatarSource): void {
    const current = this.#jobs.get(domain)
    if (current) {
      if (current.inProgress !== source) current.pending.add(source)
      return
    }
    if (this.#jobs.size >= MAX_PENDING) return
    const job: Job = { domain, pending: new Set([source]) }
    this.#jobs.set(domain, job)
    this.#queue.push(job)
    this.#drain()
  }

  #drain(): void {
    while (this.#running < CONCURRENCY && !this.#shutdown?.aborted) {
      const job = this.#queue.shift()
      if (!job) return
      this.#running++
      void this.#run(job)
        .catch((err) => {
          this.#log.log('warn', 'avatar.cache.failed', { stage: 'write', err })
        })
        .finally(() => {
          this.#jobs.delete(job.domain)
          this.#running--
          this.#drain()
        })
    }
  }

  async #run(job: Job): Promise<void> {
    const deadline = AbortSignal.timeout(LOOKUP_BUDGET)
    const signal = this.#shutdown ? AbortSignal.any([deadline, this.#shutdown]) : deadline
    while (job.pending.size && !signal.aborted) {
      const source = job.pending.has('bimi') ? 'bimi' : 'favicon'
      job.pending.delete(source)
      const previous = this.#index.get(job.domain, source)
      if (previous && previous.retryAt > this.#now()) continue
      job.inProgress = source
      const outcome = await this.#refresh(job.domain, source, previous, signal)
      job.inProgress = undefined
      if (source === 'bimi' && outcome !== 'ready') job.pending.add('favicon')
    }
  }

  async #refresh(
    domain: string,
    source: AvatarSource,
    previous: CacheEntry | null,
    deadline: AbortSignal,
  ) {
    const signal =
      source === 'bimi'
        ? AbortSignal.any([deadline, AbortSignal.timeout(LOOKUP_BUDGET / 2)])
        : deadline
    let outcome: LookupOutcome
    let asset: AvatarAsset | null = null
    try {
      const url =
        source === 'bimi'
          ? await this.#network.bimi(domain, signal)
          : new URL(`https://${domain}/favicon.ico`)
      const input = await this.#network.image(
        url,
        source === 'favicon' ? publicDomain(domain) : null,
        signal,
      )
      if (source === 'bimi' && input.type !== 'image/svg+xml') throw new AvatarLookupError('unsafe')
      const png = await this.#decode(input.bytes, input.type, signal)
      asset = { digest: createHash('sha256').update(png).digest('hex'), png }
      outcome = 'ready'
    } catch (error) {
      outcome = error instanceof AvatarLookupError ? error.outcome : 'unsafe'
    }
    if (this.#shutdown?.aborted) return outcome

    const now = this.#now()
    const failures = outcome === 'transient' ? Math.min((previous?.failures ?? 0) + 1, 7) : 0
    const ttl =
      outcome === 'ready' ? POSITIVE_TTL : failures ? 15 * MINUTE * 2 ** (failures - 1) : DAY
    const serveUntil = asset ? now + POSITIVE_TTL + 7 * DAY : (previous?.serveUntil ?? 0)
    this.#index.put(domain, source, {
      asset: asset ?? (failures && serveUntil > now ? (previous?.asset ?? null) : null),
      outcome,
      fetchedAt: now,
      retryAt: now + ttl,
      serveUntil,
      failures,
    })
    this.#log.log('debug', 'avatar.lookup.finished', {
      outcome: outcome === 'ready' ? 'hit' : outcome === 'transient' ? 'failed' : 'miss',
    })
    return outcome
  }
}
