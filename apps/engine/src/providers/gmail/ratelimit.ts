/**
 * A token bucket in Gmail quota units. New Cloud projects get a "Total Query Cost" limit of
 * 6,000 units per user per minute (100/s; messages.get = 5, list = 5, history = 2). We pace at
 * 80/s so the 15-second history polls and attachment opens always have room.
 */
export class QuotaLimiter {
  readonly #ratePerSecond: number
  readonly #capacity: number
  #tokens: number
  #last: number
  #queue: Promise<void> = Promise.resolve()

  constructor(ratePerSecond = 80, capacity = 160) {
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
