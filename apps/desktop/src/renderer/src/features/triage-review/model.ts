import type {
  BucketReviewInput,
  FilterReviewInput,
  InboxSender,
  SenderDecision,
  TriageCardId,
  TriageQueuePage,
} from '@amc/protocol'
import { failureText } from '@/lib/failure'
import type { ReviewOrganiseAction, ThreadWithMessages } from '../../../../shared/api'

export type Candidate = TriageQueuePage['cards'][number]
export type Preview = Candidate & {
  detail: ThreadWithMessages
  sender: InboxSender | null
  replyTargetId: string | null
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
  const message =
    cause instanceof Error
      ? cause.message.replace(/^Error invoking remote method '[^']+': (?:Error|EngineError): /, '')
      : ''
  const details = failureText(cause)
  if (message.startsWith('Review rejected: ')) {
    const staleRule =
      'The sender rule changed while saving the decision. Choose Accept or Block again.'
    const hint = message.split('\n')[0] === `Review rejected: ${staleRule}` ? `${staleRule} ` : ''
    return `Review rejected: ${hint}${details}`
  }
  if (message === 'This card changed. Use Retry to review the current card.') {
    return `${message} ${details}`
  }
  if (message.startsWith('Triage queue changed. Start a fresh snapshot.')) {
    return `Triage queue changed. Start a fresh snapshot. ${details}`
  }
  if (message.startsWith('Owner action unavailable')) return `Owner action unavailable. ${details}`
  return details
}

export function inboxMessageIds(card: Preview, kind: 'filter' | 'organise') {
  const label = (name: string) => `${card.accountId}:${name}`
  const excluded = (kind === 'filter' ? ['SENT', 'DRAFT', 'SPAM', 'TRASH'] : ['DRAFT']).map(label)
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
      JSON.stringify(decision.input.expectedInboxMessageIds) ===
        JSON.stringify(inboxMessageIds(b, 'filter'))
    )
  }
  if (decision?.kind === 'organise') {
    const shown = inboxMessageIds(a, 'organise')
    return (
      shown.length > 0 && JSON.stringify(shown) === JSON.stringify(inboxMessageIds(b, 'organise'))
    )
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
