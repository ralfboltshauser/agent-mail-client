import type {
  AccountSummary,
  ComposeAttachment,
  ComposeDraft,
  ComposePatch,
  ComposeStart,
  Contact,
  Draft,
  Label,
  OrganiseAction,
  OutboxItem,
  SearchHit,
  SendRequest,
  ThreadMessage,
  ThreadSummary,
} from '@amc/protocol'

/** Which Threads a list shows. */
export type View =
  | { kind: 'inbox' }
  | { kind: 'unread' }
  | { kind: 'starred' }
  | { kind: 'sent' }
  | { kind: 'outbox' }
  | { kind: 'drafts' }
  | { kind: 'all' }
  | { kind: 'snoozed' }
  | { kind: 'trash' }
  | { kind: 'label'; labelId: string }

export interface ThreadQuery {
  view: View
  accountId: string | null
  limit?: number
}

export type ReplicaThreadMessage = ThreadMessage & { bodyRevision: string }

export interface ThreadWithMessages {
  thread: ThreadSummary
  messages: ReplicaThreadMessage[]
  drafts: Draft[]
}

export interface Counts {
  inbox: number
  inboxUnread: number
  starred: number
  drafts: number
}

export type SyncPhase =
  | 'unpaired'
  | 'connecting'
  | 'bootstrapping'
  | 'live'
  | 'paused'
  | 'offline'
  | 'error'

export interface SyncStatus {
  phase: SyncPhase
  snoozeEnabled?: boolean
  healthWarnings?: string[]
  engineUrl: string | null
  /** Bootstrap progress, 0..1. */
  progress: number | null
  lastSyncAt: number | null
  error: string | null
}

/** Everything the renderer may ask of the main process. Exposed as `window.amc`. */
export interface OrganiseNotice {
  id: string
  message: string
  quiet?: boolean
  undo?: Extract<OrganiseAction, { kind: 'undo' }>
}

export interface AmcApi {
  pair(engineUrl: string, code: string): Promise<void>
  unpair(): Promise<void>
  status(): Promise<SyncStatus>
  syncNow(): Promise<void>
  organise(action: OrganiseAction): Promise<string>
  organiseErrors(): Promise<OrganiseNotice[]>

  accounts(): Promise<AccountSummary[]>
  labels(accountId: string | null): Promise<Label[]>
  counts(accountId: string | null): Promise<Counts>
  threads(query: ThreadQuery): Promise<ThreadSummary[]>
  thread(id: string): Promise<ThreadWithMessages | null>
  summaries(ids: string[]): Promise<ThreadSummary[]>
  /** Instant local filter over subject, people and snippet. */
  filter(text: string, accountId: string | null): Promise<ThreadSummary[]>
  /** Full-text search over the entire history, on the Engine. */
  search(text: string, accountId: string | null): Promise<SearchHit[]>
  contacts(text: string): Promise<Contact[]>
  startCompose(input: ComposeStart): Promise<ComposeDraft>
  composeDrafts(): Promise<Draft[]>
  composeDraft(id: string): Promise<ComposeDraft>
  stageComposeBody(id: string, patch: ComposePatch): void
  saveCompose(id: string, patch: ComposePatch): Promise<ComposeDraft>
  addComposeAttachment(
    id: string,
    name: string,
    type: string,
    bytes: Uint8Array,
    inline?: boolean,
  ): Promise<ComposeAttachment>
  composeImage(id: string, contentId: string): Promise<{ content: string; mimeType: string }>
  sendDraft(request: SendRequest): Promise<OutboxItem>
  outbox(): Promise<OutboxItem[]>
  resolveSend(id: string, action: 'check' | 'reopen'): Promise<{ draftId: string }>
  cancelSend(id: string): Promise<void>
  signature(accountId: string): Promise<{ signature: string }>
  saveSignature(accountId: string, signature: string): Promise<{ signature: string }>
  sendSettings(): Promise<{ undoSendSeconds: number }>
  saveSendSettings(undoSendSeconds: number): Promise<{ undoSendSeconds: number }>
  messageText(messageId: string): Promise<string | null>
  messageHtml(messageId: string): Promise<string | null>
  inlineAttachment(attachmentId: string): Promise<string>
  openAttachment(attachmentId: string, filename: string): Promise<void>
  openExternal(url: string): Promise<void>

  onStatus(listener: (status: SyncStatus) => void): () => void
  /** Fired after the replica changed (a sync batch was applied). */
  onChanged(listener: () => void): () => void
}

declare global {
  interface Window {
    amc: AmcApi
  }
}
