const messages = {
  'agent-missing': 'Claude Code was not found at ~/.local/bin/claude. Install it and retry.',
  'agent-auth': 'Sign in to Claude Code with a Claude.ai subscription and retry.',
  'agent-auth-check': 'Could not check Claude Code sign-in. Run claude auth status and retry.',
  'agent-start':
    'Claude Code could not start triage. Check that Claude Code is up to date and retry.',
  'agent-tools':
    'Claude Code exposed an unexpected set of tools. Check the Claude Code installation.',
  'agent-output': 'Claude Code returned invalid triage decisions. Retry triage.',
  'agent-run': 'Claude Code could not complete triage. Retry triage.',
  'engine-timeout': 'The Engine request timed out. Check the Engine connection and retry.',
  'engine-offline': 'Could not reach the Engine. Check the Engine connection and retry.',
  'engine-access': 'The Engine denied triage access. Check the Account and Engine pairing.',
  'engine-prepare': 'The Engine could not prepare triage. Check the Engine connection and retry.',
  'engine-read': 'The Engine could not load the triage batch. Check sync and retry.',
  'engine-write': 'The Engine could not save all triage decisions. Check sync and retry.',
  'engine-cleanup': 'The Engine could not revoke the triage grant. It expires within five minutes.',
  'worker-start': 'The desktop triage process could not start. Restart AMC and retry.',
  'worker-exit':
    'The desktop triage process stopped before returning a result. Restart AMC and retry.',
  timeout: 'Triage timed out. Retry triage.',
  interrupted: 'Triage was interrupted.',
  unexpected: 'An unexpected error stopped triage. Restart AMC and retry.',
}

export type TriageFailureReason = keyof typeof messages

export class TriageFailure extends Error {
  readonly reason: TriageFailureReason

  constructor(reason: TriageFailureReason, options?: ErrorOptions) {
    super(messages[reason], options)
    this.name = 'TriageFailure'
    this.reason = reason
  }
}

// Only fixed labels and messages may cross the worker boundary or reach desktop diagnostics.
export function describeTriageFailure(error: unknown) {
  const failure = error instanceof TriageFailure ? error : new TriageFailure('unexpected')
  const cause = failure.cause ?? error
  const className =
    cause instanceof Error &&
    [
      'Error',
      'TypeError',
      'SyntaxError',
      'ZodError',
      'EngineError',
      'McpError',
      'StreamableHTTPError',
      'ClaudeAuthError',
      'TimeoutError',
      'AbortError',
    ].includes(cause.name)
      ? cause.name
      : 'TriageFailure'
  return { reason: failure.reason, className, message: messages[failure.reason] }
}
