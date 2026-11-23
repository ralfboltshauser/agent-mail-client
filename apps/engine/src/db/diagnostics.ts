import { sanitizeError } from '@amc/observability'
import type { DiagnosticStatus } from '@amc/protocol'

const FAILURE_WINDOW_MS = 60_000

export class OperationStatus {
  #state: DiagnosticStatus = { lastSuccessAt: null, lastFailure: null, successes: 0, failures: 0 }
  #since = 0
  #unreportedFailures = 0
  #failing = false

  success() {
    const recovered = this.#failing
    const count = this.#unreportedFailures
    this.#state.lastSuccessAt = new Date().toISOString()
    this.#state.successes++
    this.#failing = false
    this.#unreportedFailures = 0
    this.#since = 0
    return { recovered, count }
  }

  /** Record every outcome for diagnostics. Emit the first failure and at most one per minute after it. */
  failure(error: unknown): number {
    const now = Date.now()
    const errorClass = sanitizeError(error).class
    const changed = this.#state.lastFailure?.errorClass !== errorClass
    this.#state.lastFailure = { at: new Date(now).toISOString(), errorClass }
    this.#state.failures++
    this.#unreportedFailures++
    if (this.#failing && !changed && now - this.#since < FAILURE_WINDOW_MS) return 0
    this.#failing = true
    this.#since = now
    const count = this.#unreportedFailures
    this.#unreportedFailures = 0
    return count
  }

  snapshot(): DiagnosticStatus {
    return { ...this.#state }
  }
}

export class EngineDiagnostics {
  readonly startedAt = Date.now()
  readonly sync = new Map<string, OperationStatus>()
  readonly idle = new Map<string, OperationStatus>()
  readonly pubSub = new OperationStatus()
  readonly purge = new OperationStatus()
  readonly outbox = new OperationStatus()
  readonly migrations = new OperationStatus()

  account(map: Map<string, OperationStatus>, id: string): OperationStatus {
    let status = map.get(id)
    if (!status) {
      status = new OperationStatus()
      map.set(id, status)
    }
    return status
  }
}
