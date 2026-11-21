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
  #lastPenalty = 0
  #urgentWaiting = 0

  constructor(options: { rate?: number; maxRate?: number; minRate?: number } = {}) {
    this.#maxRate = options.maxRate ?? 95
    this.#minRate = options.minRate ?? 10
    this.#rate = options.rate ?? 80
    this.#tokens = this.#rate
    this.#last = Date.now()
  }

  get rate(): number {
    return this.#rate
  }

  /**
   * Waits until `units` can be spent. Background calls are served in order; urgent calls
   * (new mail, drafts, attachments the owner opened) skip that queue and go next.
   */
  take(units: number, urgent = false): Promise<void> {
    if (urgent) {
      this.#urgentWaiting++
      return this.#wait(units).finally(() => {
        this.#urgentWaiting--
      })
    }
    const turn = this.#queue.then(async () => {
      while (this.#urgentWaiting > 0) await new Promise((resolve) => setTimeout(resolve, 50))
      await this.#wait(units)
    })
    this.#queue = turn
    return turn
  }

  async #wait(units: number): Promise<void> {
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
  }

  /** A quota error: back off hard and drain the bucket. */
  penalize(): void {
    // Parallel requests fail together; count one burst of failures as one signal.
    const now = Date.now()
    if (now - this.#lastPenalty < 5_000) return
    this.#lastPenalty = now
    this.#rate = Math.max(this.#minRate, this.#rate / 2)
    this.#tokens = 0
  }

  /** A successful call: speed up slowly. */
  reward(): void {
    this.#rate = Math.min(this.#maxRate, this.#rate + 0.5)
  }
}

export const QUOTA_COST: Record<string, number> = {
  profile: 1,
  labels: 1,
  list: 5,
  // Not the documented 5: new projects are charged about 20 per messages.get under the
  // 6,000 units/user/min "Total Query Cost" limit (observed; see the M1 PR).
  get: 20,
  history: 2,
  attachment: 5,
  draftCreate: 10,
  draftUpdate: 15,
  draftDelete: 10,
  batchModify: 50,
  trash: 20,
  untrash: 5,
  labelCreate: 5,
}
