/**
 * A token bucket in Gmail quota units. Gmail allows 15,000 units per user per minute
 * (messages.get = 5, list = 5, history = 2); we stay under it with headroom, because the
 * owner's other Gmail clients share nothing with us but Google may still count bursts.
 */
export class QuotaLimiter {
  readonly #ratePerSecond: number
  readonly #capacity: number
  #tokens: number
  #last: number
  #queue: Promise<void> = Promise.resolve()

  constructor(ratePerSecond = 150, capacity = 300) {
    this.#ratePerSecond = ratePerSecond
    this.#capacity = capacity
    this.#tokens = capacity
    this.#last = Date.now()
  }

  /** Waits until `units` can be spent. Calls are served in order. */
  take(units: number): Promise<void> {
    const turn = this.#queue.then(async () => {
      for (;;) {
        const now = Date.now()
        this.#tokens = Math.min(
          this.#capacity,
          this.#tokens + ((now - this.#last) / 1000) * this.#ratePerSecond,
        )
        this.#last = now
        if (this.#tokens >= units) {
          this.#tokens -= units
          return
        }
        await new Promise((resolve) =>
          setTimeout(resolve, ((units - this.#tokens) / this.#ratePerSecond) * 1000),
        )
      }
    })
    this.#queue = turn
    return turn
  }
}

export const QUOTA_COST: Record<string, number> = {
  profile: 1,
  labels: 1,
  list: 5,
  get: 5,
  history: 2,
  attachment: 5,
}
