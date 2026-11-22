import { DRAFT_MISSING } from '@amc/protocol'

export const DRAFT_POLL_INTERVAL = 1500
export const DRAFT_DISCARDED_ELSEWHERE = 'This draft was discarded elsewhere'

export function isMissingDraft(cause: unknown) {
  // Electron serializes invoke errors with a prefix and drops custom properties.
  return (
    cause instanceof Error &&
    (cause.message === DRAFT_MISSING || cause.message.endsWith(`: Error: ${DRAFT_MISSING}`))
  )
}
