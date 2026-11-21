import type { TriageResult, TriageStatus } from '../shared/api'

const DEBOUNCE = 2 * 60_000
const COOLDOWN = 10 * 60_000

interface TriageOptions {
  enabled: boolean
  lastRun: TriageStatus['lastRun']
  onLowBattery: () => Promise<boolean>
  accountForRun: (
    accountId: string | null,
    pending?: ReadonlyMap<string, string>,
  ) => string | undefined
  saveLastRun: (lastRun: TriageStatus['lastRun']) => void
  changed: (status: TriageStatus) => void
}

type Run = (accountId: string, signal: AbortSignal, recent: boolean) => Promise<TriageResult | null>

export class AutoTriage {
  readonly #options: TriageOptions
  readonly #pending = new Map<string, string>()
  #enabled: boolean
  #lastRun: TriageStatus['lastRun']
  #notice: string | null = null
  #run: Run | null = null
  #available = false
  #lastArrival = 0
  #retryAt = 0
  #timer: ReturnType<typeof setTimeout> | undefined
  #controller: AbortController | null = null
  #active: Promise<void> | undefined

  constructor(options: TriageOptions) {
    this.#options = options
    this.#enabled = options.enabled
    this.#lastRun = options.lastRun
  }

  get status(): TriageStatus {
    return {
      enabled: this.#enabled,
      running: !!this.#active,
      lastRun: this.#lastRun,
      notice: this.#notice,
    }
  }

  connect(run: Run | null) {
    this.#pending.clear()
    this.#retryAt = 0
    this.#notice = null
    this.#run = run
    this.setAvailable(false)
  }

  setAvailable(available: boolean) {
    if (this.#available === available) return
    this.#available = available
    if (!available) this.#controller?.abort()
    this.#schedule()
  }

  setEnabled(enabled: boolean) {
    this.#enabled = enabled
    if (!enabled) {
      this.#pending.clear()
      this.#retryAt = 0
      this.#notice = null
    }
    this.#schedule()
    this.#publish()
  }

  arrivals(threads: ReadonlyMap<string, string>) {
    if (!this.#enabled || !threads.size) return
    for (const [id, accountId] of threads) this.#pending.set(id, accountId)
    this.#lastArrival = Date.now()
    this.#schedule()
  }

  now(accountId: string | null) {
    return this.#attempt(accountId, true)
  }

  stop() {
    this.setAvailable(false)
    return this.#active
  }

  #publish() {
    this.#options.changed(this.status)
  }

  #schedule() {
    clearTimeout(this.#timer)
    if (!this.#enabled || !this.#available || this.#active || !this.#pending.size) return
    const next = Math.max(
      this.#lastArrival + DEBOUNCE,
      (this.#lastRun?.at ?? -Infinity) + COOLDOWN,
      this.#retryAt,
    )
    this.#timer = setTimeout(() => void this.#attempt(null, false), Math.max(0, next - Date.now()))
  }

  async #attempt(requestedAccount: string | null, manual: boolean) {
    if (this.#active) return
    const run = this.#run
    if (!this.#available || !run) {
      if (manual) this.#skip('Resume sync to triage mail.')
      return
    }
    if (!manual && !this.#enabled) return
    const controller = new AbortController()
    this.#controller = controller
    const { signal } = controller
    this.#active = Promise.resolve().then(async () => {
      try {
        const account = this.#options.accountForRun(
          requestedAccount,
          manual ? undefined : this.#pending,
        )
        if (!account) {
          if (!manual) this.#pending.clear()
          this.#skip('No untriaged Inbox threads.')
          return
        }
        const last = this.#lastRun?.at ?? -Infinity
        if (last + COOLDOWN > Date.now()) {
          this.#retryAt = last + COOLDOWN
          this.#skip('Triage ran in the last 10 minutes.')
          return
        }
        const lowBattery = await this.#options.onLowBattery()
        if (
          signal.aborted ||
          (!manual && (!this.#enabled || this.#lastArrival + DEBOUNCE > Date.now()))
        )
          return
        if (lowBattery) {
          this.#retryAt = Date.now() + COOLDOWN
          this.#skip('Triage is waiting for power or a battery reading of at least 20%.')
          return
        }
        this.#retryAt = 0
        this.#notice = null
        const pending = [...this.#pending].filter(([, accountId]) => accountId === account)
        for (const [id] of pending) this.#pending.delete(id)
        const at = Date.now()
        try {
          const result = await run(account, signal, !manual)
          if (result === null) {
            if (this.#run === run && this.#enabled) {
              for (const [id, accountId] of pending) this.#pending.set(id, accountId)
            }
            this.#retryAt = Date.now() + COOLDOWN
            this.#skip('Triage is already running on another client.')
            return
          }
          this.#record({ at, result, error: null })
          // A full batch may leave some arrivals waiting for the next slot.
          if (result.assigned + result.skipped === 20 && !signal.aborted && this.#enabled) {
            for (const [id, accountId] of pending) this.#pending.set(id, accountId)
          }
        } catch (error) {
          const message = signal.aborted
            ? 'Triage was interrupted.'
            : error instanceof TriageWorkerError
              ? error.message
              : 'Triage failed.'
          this.#record({ at, result: null, error: message })
          if (signal.aborted && this.#run === run && this.#enabled) {
            for (const [id, accountId] of pending) this.#pending.set(id, accountId)
          }
        }
      } catch {
        this.#retryAt = Date.now() + COOLDOWN
        this.#skip('Could not prepare triage.')
      } finally {
        this.#active = undefined
        this.#controller = null
        this.#publish()
        this.#schedule()
      }
    })
    this.#publish()
    return this.#active
  }

  #record(lastRun: TriageStatus['lastRun']) {
    this.#lastRun = lastRun
    this.#options.saveLastRun(lastRun)
  }

  #skip(notice: string) {
    this.#notice = notice
    this.#publish()
  }
}

export class TriageWorkerError extends Error {}
