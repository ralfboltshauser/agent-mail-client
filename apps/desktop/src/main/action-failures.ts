import { newRequestId, type RequestId } from '@amc/observability'
import { type OutboxItem, type OwnerActionStatus, SEND_ACCOUNT_UNAVAILABLE } from '@amc/protocol'
import { formatFailure } from '../shared/failure'
import { EngineError, requestFor } from './engine'
import { operationFailure } from './observability'

const recentFailures = new Map<string, string>()

function describe(
  stage: 'owner-action' | 'delivery',
  id: string,
  status: string,
  requestId?: RequestId,
) {
  const key = JSON.stringify([stage, id, status])
  const existing = recentFailures.get(key)
  if (existing) return existing
  const err = new EngineError(0, 'error', 'The Engine reported an unsuccessful action')
  const failure = operationFailure(stage, err, {
    errorClass: 'EngineError',
    kind: 'Request',
    id: requestId ?? newRequestId(),
  })
  const text = formatFailure(failure)
  recentFailures.set(key, text)
  const oldest = recentFailures.keys().next().value
  if (recentFailures.size > 256 && oldest !== undefined) recentFailures.delete(oldest)
  return text
}

function ownerAction(action: OwnerActionStatus): OwnerActionStatus {
  const requestId = requestFor(action)
  const project = (value: { status: string; error: string | null }, suffix: string) => {
    if (!value.error && value.status !== 'failed' && value.status !== 'partial') return null
    const detail = describe('owner-action', action.actionId + suffix, value.status, requestId)
    // Preserve the existing Adopt destination repair affordance with a fixed hint.
    if (value.error && /adopt|already in use/i.test(value.error)) {
      return `A destination is already in use. Choose Adopt to continue.\n${detail}`
    }
    return detail
  }
  return {
    ...action,
    error: project(action, ''),
    undo: action.undo && { ...action.undo, error: project(action.undo, ':undo') },
  }
}

function outbox(item: OutboxItem, requestId: RequestId | undefined): OutboxItem {
  if (!item.detail && item.status !== 'failed' && item.status !== 'uncertain') return item
  const failure = describe('delivery', item.id, item.status, requestId)
  const hint = item.detail === SEND_ACCOUNT_UNAVAILABLE ? `${SEND_ACCOUNT_UNAVAILABLE}\n` : ''
  return { ...item, detail: hint + failure }
}

const ownerChannels = new Set([
  'amc:decideSender',
  'amc:reviewFilter',
  'amc:filterThread',
  'amc:restoreFiltered',
  'amc:editOwnerReason',
  'amc:adoptScreenedDestination',
  'amc:ownerAction',
  'amc:undoOwnerAction',
  'amc:reviewBucket',
])

export function projectActionFailures(channel: string, value: unknown): unknown {
  if (!value || typeof value !== 'object') return value
  if (ownerChannels.has(channel) && 'actionId' in value && 'status' in value) {
    return ownerAction(value as OwnerActionStatus)
  }
  if (channel === 'amc:outbox' && Array.isArray(value)) {
    const requestId = requestFor(value)
    if (value.every((item) => item && typeof item === 'object' && 'status' in item))
      return value.map((item: OutboxItem) => outbox(item, requestId))
  }
  if (channel === 'amc:sendDraft' && 'status' in value) {
    return outbox(value as OutboxItem, requestFor(value))
  }
  return value
}
