import {
  type TriageFailureReason,
  triageErrorClasses,
  triageFailureMessages,
} from '@amc/observability'

export type { TriageFailureReason }

export class TriageFailure extends Error {
  readonly reason: TriageFailureReason

  constructor(reason: TriageFailureReason, options?: ErrorOptions) {
    super(triageFailureMessages[reason], options)
    this.name = 'TriageFailure'
    this.reason = reason
  }
}

// Only fixed labels and messages may cross the worker boundary or reach desktop diagnostics.
export function describeTriageFailure(error: unknown) {
  const failure = error instanceof TriageFailure ? error : new TriageFailure('unexpected')
  const cause = failure.cause ?? error
  const className =
    (cause instanceof Error && triageErrorClasses.find((name) => name === cause.name)) ||
    'TriageFailure'
  return { reason: failure.reason, className, message: triageFailureMessages[failure.reason] }
}
