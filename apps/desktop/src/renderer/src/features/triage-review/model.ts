import type {
  BucketReviewInput,
  FilterReviewInput,
  InboxSender,
  SenderDecision,
  TriageCardId,
  TriageQueuePage,
} from '@amc/protocol'
import type { ReviewOrganiseAction, ThreadWithMessages } from '../../../../shared/api'

export type Candidate = TriageQueuePage['cards'][number]
export type Preview = Candidate & {
  detail: ThreadWithMessages
  sender: InboxSender | null
  canReply: boolean
}
export type Decision =
  | { kind: 'sender'; input: SenderDecision }
  | { kind: 'filter'; input: FilterReviewInput }
  | { kind: 'bucket'; input: BucketReviewInput }
  | { kind: 'organise'; input: Exclude<ReviewOrganiseAction, { kind: 'undo' }> }
  | { kind: 'skip' }
  | { kind: 'reply'; deadline: number; draftId: string }

export type ActionStatus =
  | 'unconfirmed'
  | 'rejected'
  | 'pending'
  | 'applied'
  | 'failed'
  | 'partial'
  | 'superseded'
  | 'undone'

export interface ReviewAction {
  id: string
  card: TriageCardId
  accountId: string
  threadId: string
  messageId: string
  index: number
  batch: string
  label: string
  ownerReason?: string | null
  alreadyApplied?: true
  privateReasonDraft?: true
  decision: Decision
  status: ActionStatus
  error: string | null
  undo?: { id: string; status: ActionStatus; error: string | null }
}

export interface Session {
  batch: string
  ids: TriageCardId[]
  index: number
}

export const cardKey = (id: TriageCardId) =>
  JSON.stringify(id.kind === 'sender' ? [id.accountId, id.address] : [id.threadId])

export function reviewError(cause: unknown) {
  return (cause instanceof Error ? cause.message : String(cause)).replace(
    /^Error invoking remote method '[^']+': (?:Error|EngineError): /,
    '',
  )
}

export function inboxMessageIds(card: Preview) {
  const label = (name: string) => `${card.accountId}:${name}`
  const excluded = ['SENT', 'DRAFT', 'SPAM', 'TRASH'].map(label)
  return card.detail.messages
    .filter(
      ({ labelIds }) =>
        labelIds.includes(label('INBOX')) && !excluded.some((id) => labelIds.includes(id)),
    )
    .map(({ id }) => id)
    .sort()
}

export function sameTarget(a: Preview, b: Preview, decision?: Decision) {
  if (a.threadId !== b.threadId || a.messageId !== b.messageId) return false
  if (decision?.kind === 'filter' && decision.input.expectedInboxMessageIds) {
    return (
      a.predictionId === b.predictionId &&
      JSON.stringify(decision.input.expectedInboxMessageIds) === JSON.stringify(inboxMessageIds(b))
    )
  }
  if (decision?.kind === 'organise') {
    const shown = inboxMessageIds(a)
    return shown.length > 0 && JSON.stringify(shown) === JSON.stringify(inboxMessageIds(b))
  }
  if (decision?.kind === 'bucket' && decision.input.expectedBucketTarget) {
    const target = decision.input.expectedBucketTarget
    return (
      target.messageId === b.bucketTarget?.messageId &&
      target.revision === b.bucketTarget.revision &&
      a.bucketPredictionId === b.bucketPredictionId
    )
  }
  return (
    a.threadRevision === b.threadRevision &&
    a.revision === b.revision &&
    a.predictionId === b.predictionId &&
    a.bucketPredictionId === b.bucketPredictionId
  )
}
