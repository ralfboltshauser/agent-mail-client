import { recordCaughtFailure } from '@/lib/failure'
import type { AmcApi, ReviewApi, SmartInboxApi } from '../../../../shared/api'
import type { ActionStatus, ReviewAction, Session } from './model'

const errorFormatVersion = 1
const storageKey = 'amc-triage-review-v1'
export interface SavedReview {
  scope: string
  sessions: Record<string, Session>
  parked?: Record<string, { accountKey: string; session: Session }>
  history: ReviewAction[]
  errorFormatVersion?: number
}

export function loadReview(scope: string): SavedReview {
  try {
    const saved = JSON.parse(localStorage.getItem(storageKey) ?? 'null') as SavedReview | null
    if (saved?.scope === scope && saved.sessions && Array.isArray(saved.history)) {
      if (saved.errorFormatVersion !== errorFormatVersion) {
        for (const action of saved.history) {
          if (action.error) {
            action.error = /adopt|already in use/i.test(action.error)
              ? 'A destination is already in use. Choose Adopt to continue.'
              : 'The previous action reported a failure.'
          }
          if (action.undo?.error) action.undo.error = 'The previous Undo reported a failure.'
        }
      }
      return saved
    }
    localStorage.removeItem(storageKey)
  } catch (error) {
    recordCaughtFailure(error)

    // A missing or unreadable local cache starts a fresh session.
  }
  return { scope, sessions: {}, history: [] }
}

export function saveReview(saved: SavedReview) {
  const history = saved.history.map(({ ownerReason: _, ...action }) => {
    const { decision } = action
    if (decision.kind !== 'filter' && decision.kind !== 'sender') return action
    const { reason, ...input } = decision.input
    return {
      ...action,
      decision: { ...decision, input },
      ...(reason && action.status === 'unconfirmed' ? { privateReasonDraft: true } : {}),
    }
  })
  localStorage.setItem(storageKey, JSON.stringify({ ...saved, errorFormatVersion, history }))
}

export function statusLabel(status: ActionStatus) {
  switch (status) {
    case 'unconfirmed':
      return 'Unconfirmed'
    case 'pending':
      return 'Queued'
    case 'applied':
      return 'Applied'
    case 'failed':
    case 'rejected':
      return 'Failed'
    case 'partial':
      return 'Partially applied'
    case 'superseded':
      return 'Changed elsewhere'
    case 'undone':
      return 'Undone'
  }
}

export function canUndo(action: ReviewAction) {
  if (action.alreadyApplied) return false
  if (action.undo && action.undo.status !== 'unconfirmed' && action.undo.status !== 'failed')
    return false
  if (action.decision.kind === 'reply' && Date.now() >= action.decision.deadline) return false
  if (action.decision.kind === 'reply') return action.status === 'pending'
  if (action.decision.kind === 'organise')
    return ['pending', 'applied', 'partial'].includes(action.status)
  return !['undone', 'superseded', 'rejected'].includes(action.status)
}

export async function submit(api: SmartInboxApi & ReviewApi, action: ReviewAction) {
  const { decision } = action
  switch (decision.kind) {
    case 'sender':
      return api.decideSender(decision.input)
    case 'filter':
      if (!api.reviewFilter) throw new Error('Filter out is unavailable')
      return api.reviewFilter(decision.input)
    case 'bucket':
      return api.reviewBucket(decision.input)
    case 'organise':
      await api.reviewOrganise(decision.input, action.id, action.messageId)
      return { status: 'pending' as const, error: null }
    default:
      return { status: 'applied' as const, error: null }
  }
}

export async function undo(
  api: AmcApi,
  smart: SmartInboxApi & ReviewApi,
  action: ReviewAction,
  undoId: string,
) {
  switch (action.decision.kind) {
    case 'reply':
      if (Date.now() >= action.decision.deadline) throw new Error('The send Undo window has closed')
      await api.cancelSend(action.id)
      return { status: 'applied' as const, error: null }
    case 'organise':
      await smart.reviewOrganise(
        { kind: 'undo', threadId: action.threadId, mutationId: action.id },
        undoId,
      )
      return { status: 'pending' as const, error: null }
    case 'skip':
      return { status: 'applied' as const, error: null }
    default: {
      const result = await smart.undoOwnerAction(action.id)
      if (!result.undo) throw new Error('Undo has not been confirmed')
      return result.undo
    }
  }
}

export async function poll(
  api: AmcApi,
  smart: SmartInboxApi & ReviewApi,
  action: ReviewAction,
): Promise<Partial<ReviewAction> | null> {
  if (action.decision.kind === 'reply') {
    if (action.status !== 'pending') return null
    const item = (await api.outbox()).find(({ id }) => id === action.id)
    if (!item || item.status === 'queued' || item.status === 'dispatching') return null
    if (item.status === 'cancelled' && action.undo?.status === 'unconfirmed') {
      return { undo: { ...action.undo, status: 'applied', error: null } }
    }
    return {
      status: item.status === 'sent' ? ('applied' as const) : ('failed' as const),
      error:
        item.status === 'sent' ? null : (item.detail ?? 'Check the Outbox for delivery details.'),
    }
  }
  if (action.decision.kind === 'organise') {
    const id =
      action.undo && ['pending', 'unconfirmed'].includes(action.undo.status)
        ? action.undo.id
        : action.id
    const status = await smart.reviewOrganiseStatus(id)
    return status && id !== action.id ? { undo: { id, ...status } } : status
  }
  if (action.decision.kind === 'skip') return null
  const status = await smart.ownerAction(action.id)
  return {
    status: status.status,
    error: status.error,
    alreadyApplied: status.alreadyApplied,
    ...(status.undo ? { undo: { id: action.undo?.id ?? action.id, ...status.undo } } : {}),
  }
}
