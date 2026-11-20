/**
 * An adaptive token bucket in Gmail quota units.
 *
 * New Cloud projects get a "Total Query Cost" limit of 6,000 units per user per minute, and
 * Google does not publish what each call costs under it (it is more than the documented
 * 5 units for messages.get). So the limiter learns: it halves its rate on every quota error
 * and creeps back up while calls succeed, settling just under whatever the real limit is.
 */
export class QuotaLimiter {
  readonly #maxRate: number
  readonly #minRate: number
  #rate: number
  #tokens: number
  #last: number
  #queue: Promise<void> = Promise.resolve()

  constructor(options: { rate?: number; maxRate?: number; minRate?: number } = {}) {
    this.#maxRate = options.maxRate ?? 90
    this.#minRate = options.minRate ?? 5
    this.#rate = options.rate ?? 40
    this.#tokens = this.#rate
    this.#last = Date.now()
  }

  get rate(): number {
    return this.#rate
  }

  /** Waits until `units` can be spent. Calls are served in order. */
  take(units: number): Promise<void> {
    const turn = this.#queue.then(async () => {
      for (;;) {
        const now = Date.now()
        // Never bank more than two seconds' worth, so a quiet spell does not become a burst.
        this.#tokens = Math.min(
          this.#rate * 2,
          this.#tokens + ((now - this.#last) / 1000) * this.#rate,
        )
        this.#last = now
        if (this.#tokens >= units) {
          this.#tokens -= units
          return
        }
        await new Promise((resolve) =>
          setTimeout(resolve, ((units - this.#tokens) / this.#rate) * 1000),
        )
      }
    })
    this.#queue = turn
    return turn
  }

  /** A quota error: back off hard and drain the bucket. */
  penalize(): void {
    this.#rate = Math.max(this.#minRate, this.#rate / 2)
    this.#tokens = 0
  }

  /** A successful call: speed up slowly. */
  reward(): void {
    this.#rate = Math.min(this.#maxRate, this.#rate * 1.01)
  }
}

export const QUOTA_COST: Record<string, number> = {
  profile: 1,
  labels: 1,
  list: 5,
  get: 5,
  history: 2,
  attachment: 5,
  draftCreate: 10,
  draftUpdate: 15,
  draftDelete: 10,
}
