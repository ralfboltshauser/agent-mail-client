import type { RequestId } from '@amc/observability'

type FinishPoll = ((ok: boolean) => void) & { requestId?: RequestId }

/** A manual request joins the next pass through the existing, serial provider loop. */
export class ManualPoll {
  readonly #signal: AbortSignal
  #pending?: FinishPoll
  #waiting?: AbortController
  #backingOff = false

  constructor(signal: AbortSignal) {
    this.#signal = signal
  }

  request(requestId?: RequestId): Promise<boolean> {
    const signal = this.#signal
    if (signal.aborted || this.#backingOff) return Promise.resolve(false)
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
      this.#pending = Object.assign(finish, { requestId })
      this.#waiting?.abort()
    })
  }

  take(): FinishPoll | undefined {
    const finish = this.#pending
    this.#pending = undefined
    return finish
  }

  /** Provider retry delays cannot be interrupted by an owner request. */
  async backoff(wait: () => Promise<unknown>): Promise<void> {
    this.#backingOff = true
    this.take()?.(false)
    try {
      await wait()
    } finally {
      this.#backingOff = false
    }
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
