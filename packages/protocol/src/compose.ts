import type { Address, Draft } from './mail.ts'

export interface ComposeAttachment {
  id: string
  filename: string
  mimeType: string
  contentId: string | null
  size: number
}

export interface ComposeDraft extends Draft {
  revision: number
  update: string
  attachments: ComposeAttachment[]
  quote: string
  signature: string
  mirrorError: boolean
  mirrorConflict: boolean
}

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

export const DRAFT_CHANGED = 'Draft changed. Review before sending'
export const MIRROR_CHANGED =
  'Send cancelled. The provider draft was changed or removed. Review it before sending.'
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
  detail: string | null
  canResolve: boolean
  threadId: string | null
}
