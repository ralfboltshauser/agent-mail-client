import type { Address, Draft } from './mail.ts'

export interface ComposeAttachment {
  id: string
  filename: string
  mimeType: string
  contentId: string | null
  size: number
}

export interface VersionedDraft extends Draft {
  revision: number
}

export interface ComposeDraft extends VersionedDraft {
  update: string
  attachments: ComposeAttachment[]
  quote: string
  signature: string
  mirrorError: boolean
  mirrorConflict: boolean
  originalDraftLeft?: boolean
}

export type DiscardDraftResult =
  | { absent: string }
  | { deleted: string; providerRemoved?: 'Gmail' | 'IMAP'; warning?: string }

export interface ComposeStart {
  accountId?: string
  threadId?: string
  mode: 'new' | 'reply' | 'reply-all' | 'forward'
}

export interface ComposeFields {
  accountId: string
  to: Address[]
  cc: Address[]
  bcc: Address[]
  subject: string
  attachmentIds: string[]
}

export interface ComposePatch {
  baseRevision: number
  update: string
  fields?: ComposeFields
}

export const DRAFT_MISSING = 'Draft does not exist'
export const DRAFT_CHANGED = 'Draft changed. Review before sending'
export const MIRROR_CHANGED =
  'Send cancelled. The provider draft was changed or removed. Review it before sending.'
export const ORIGINAL_DRAFT_LEFT = 'Original draft left on server'
export const SEND_NEEDS_SIGN_IN = 'Needs attention: sign in again'
export const SEND_ACCOUNT_UNAVAILABLE = 'The sending Account is unavailable.'

export interface SendRequest {
  id: string
  draftId: string
  revision: number
  sendAt?: number
  edits?: Omit<ComposePatch, 'baseRevision'>
}

export type OutboxStatus = 'queued' | 'dispatching' | 'sent' | 'cancelled' | 'uncertain' | 'failed'

export interface OutboxItem {
  id: string
  draftId: string
  accountId: string
  messageId: string
  subject: string
  to: Address[]
  status: OutboxStatus
  sendAt: number
  undoUntil: number
  /** Time remaining on the Engine clock when it produced this item. */
  undoRemainingMs?: number
  /** Engine request time up to the Undo window measurement, on enqueue responses only. */
  undoResponseElapsedMs?: number
  originalDraftLeft?: boolean
  detail: string | null
  canResolve: boolean
  threadId: string | null
}
