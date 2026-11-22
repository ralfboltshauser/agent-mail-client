import type {
  BucketReviewInput,
  SenderDecision,
  TriageCardId,
  TriageQueuePage,
} from '@amc/protocol'
import type { ReviewOrganiseAction, ThreadWithMessages } from '../../../../shared/api'

export type Candidate = TriageQueuePage['cards'][number]
export type Preview = Candidate & {
  detail: ThreadWithMessages
  sender: { address: string; revision: number; name?: string | null } | null
  canReply: boolean
}
export type Decision =
  | { kind: 'sender'; input: SenderDecision }
  | { kind: 'bucket'; input: BucketReviewInput }
  | { kind: 'organise'; input: Exclude<ReviewOrganiseAction, { kind: 'undo' }> }
  | { kind: 'skip' }
  | { kind: 'reply'; deadline: number; draftId: string }

export type ActionStatus =
  | 'unconfirmed'
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
  decision: Decision
  status: ActionStatus
  error: string | null
  undo?: { id: string; status: ActionStatus; error: string | null }
}

export interface Session {
  batch: string
  ids: TriageCardId[]
  index: number
  cursor: string | null
}

export const cardKey = (id: TriageCardId) =>
  JSON.stringify(id.kind === 'sender' ? [id.accountId, id.address] : [id.threadId])

export function reviewError(cause: unknown) {
  return (cause instanceof Error ? cause.message : String(cause)).replace(
    /^Error invoking remote method '[^']+': (?:Error|EngineError): /,
    '',
  )
}

export function sameTarget(a: Candidate, b: Candidate) {
  return (
    a.threadId === b.threadId &&
    a.messageId === b.messageId &&
    a.threadRevision === b.threadRevision &&
    a.revision === b.revision
  )
}
