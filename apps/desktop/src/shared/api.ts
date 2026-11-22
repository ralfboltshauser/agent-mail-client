import type {
  AccountSummary,
  AgentAction,
  Bucket,
  BucketInput,
  ComposeAttachment,
  ComposeDraft,
  ComposePatch,
  ComposeStart,
  Contact,
  DiscardDraftResult,
  Draft,
  Label,
  OrganiseAction,
  OutboxItem,
  SearchHit,
  SendRequest,
  ThreadMessage,
  ThreadSummary,
  VersionedDraft,
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
  | { kind: 'bucket'; bucket: Bucket }
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
  buckets: Partial<Record<Bucket, number>>
}

export type SyncPhase =
  | 'unpaired'
  | 'restoring-pairing'
  | 'pairing-read-error'
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
  healthRefreshFailed?: boolean
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
  updateOnly?: boolean
  undo?: Extract<OrganiseAction, { kind: 'undo' }>
}

export interface ActiveHandoff {
  id: string
  expiresAt: number
}

export type T3RuntimeMode = 'approval-required' | 'auto-accept-edits' | 'auto' | 'full-access'

export interface T3Project {
  id: string
  title: string
  localDefaultMode?: T3RuntimeMode | 'unknown'
  archivedAt?: string | null
  deletedAt?: string | null
}

export interface NotificationSettings {
  enabled: boolean
  showSnippet: boolean
  quietStart: string
  quietEnd: string
}

export interface TriageResult {
  assigned: number
  skipped: number
}

export interface TriageCounts {
  recent: number
  older: number
}

export interface TriageStatus {
  enabled: boolean
  running: boolean
  lastRun: {
    at: number
    result: TriageResult | null
    error: string | null
  } | null
  notice: string | null
}

export interface AmcApi {
  notificationSettings(): Promise<NotificationSettings>
  saveNotificationSettings(settings: NotificationSettings): Promise<void>
  onOpenThread(listener: (thread: ThreadSummary) => void): () => void
  triageStatus(): Promise<TriageStatus>
  setAutoTriage(enabled: boolean): Promise<void>
  triageCounts(accountId: string | null): Promise<TriageCounts>
  triageNow(accountId: string | null, scope: 'recent' | 'account'): Promise<void>
  onTriageStatus(listener: (status: TriageStatus) => void): () => void
  t3Setup(): Promise<{ kind: 'cli' | 'mcp'; address: string }>
  t3Projects(address: string | null): Promise<T3Project[]>
  handoff(address: string | null, projectId: string, threadId: string): Promise<ComposeDraft>
  cancelHandoff(address: string | null, projectId: string, threadId: string): Promise<void>
  activeHandoff(threadId: string): Promise<ActiveHandoff | null>
  endHandoff(id: string): Promise<void>
  pair(engineUrl: string, code: string): Promise<void>
  retrySavedPairing(): Promise<void>
  unpair(): Promise<void>
  status(): Promise<SyncStatus>
  syncNow(): Promise<void>
  setBucket(input: BucketInput): Promise<void>
  organise(action: OrganiseAction): Promise<string>
  organiseErrors(): Promise<OrganiseNotice[]>
  agentActivity(before?: number): Promise<{ actions: AgentAction[]; nextBefore: number | null }>
  undoAgentAction(id: string): Promise<void>

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
  composeDrafts(): Promise<VersionedDraft[]>
  composeDraft(id: string): Promise<ComposeDraft>
  discardDraft(id: string, revision: number): Promise<DiscardDraftResult>
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
