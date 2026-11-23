/** A manual request joins the next pass through the existing, serial provider loop. */
export class ManualPoll {
  readonly #signal: AbortSignal
  #pending?: (ok: boolean) => void
  #waiting?: AbortController

  constructor(signal: AbortSignal) {
    this.#signal = signal
  }

  request(): Promise<boolean> {
    const signal = this.#signal
    if (signal.aborted) return Promise.resolve(false)
    return new Promise((resolve) => {
      const abort = () => {
        this.#pending = undefined
        finish(false)
      }
      const finish = (ok: boolean) => {
        signal.removeEventListener('abort', abort)
        resolve(ok)
      }
      signal.addEventListener('abort', abort, { once: true })
      this.#pending = finish
      this.#waiting?.abort()
    })
  }

  take(): ((ok: boolean) => void) | undefined {
    const finish = this.#pending
    this.#pending = undefined
    return finish
  }

  async wait(wait: (wake: AbortSignal) => Promise<unknown>): Promise<void> {
    if (this.#pending || this.#signal.aborted) return
    const waiting = new AbortController()
    this.#waiting = waiting
    try {
      await wait(waiting.signal)
    } finally {
      this.#waiting = undefined
    }
  }
}
