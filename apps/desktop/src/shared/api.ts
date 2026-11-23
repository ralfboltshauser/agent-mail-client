import type { Level, RendererLogReport, triageErrorClasses } from '@amc/observability'
import type {
  AccountSummary,
  AdoptScreenedDestination,
  AgentAction,
  Bucket,
  BucketInput,
  BucketReviewInput,
  ComposeAttachment,
  ComposeDraft,
  ComposePatch,
  ComposeStart,
  Contact,
  DiscardDraftResult,
  Draft,
  FilterReviewInput,
  Label,
  OrganiseAction,
  OutboxItem,
  OwnerActionStatus,
  SearchHit,
  SenderAvatarResolve,
  SenderAvatarResults,
  SenderDecision,
  SenderList,
  SenderListQuery,
  SendRequest,
  ThreadMessage,
  ThreadSummary,
  TriageQueuePage,
  TriageQueueRequest,
  VersionedDraft,
} from '@amc/protocol'
import type { FailureDetails } from './failure'

import type { FeedbackApi } from './feedback'

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

export type DesktopThreadSummary = ThreadSummary & {
  latestSender?: { messageId: string; from: ThreadMessage['from'] }
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
  filteredByLabel?: Record<string, number>
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
  healthFailure?: FailureDetails
  accountFailures?: Record<string, FailureDetails>
  failure?: FailureDetails
  mailCheckFailure?: FailureDetails
  mailCheck?: 'checking' | 'failed'
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
  description?: string
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
    failure?: Omit<FailureDetails, 'errorClass'> & {
      errorClass: FailureDetails['errorClass'] | (typeof triageErrorClasses)[number]
    }
  } | null
  notice: string | null
}

export type ReviewOrganiseAction = Extract<OrganiseAction, { kind: 'archive' | 'snooze' | 'undo' }>
export interface ReviewOrganiseStatus {
  status: 'pending' | 'applied' | 'failed' | 'partial'
  error: string | null
}

export interface DesktopSenderAvatarResults {
  rows: (SenderAvatarResults['rows'][number] & { image?: string | null })[]
}

export interface ReviewApi {
  reviewPairing(): Promise<string>
  reviewBucket(input: BucketReviewInput): Promise<OwnerActionStatus>
  reviewOrganise(input: ReviewOrganiseAction, id: string, messageId?: string): Promise<string>
  reviewOrganiseStatus(id: string): Promise<ReviewOrganiseStatus | null>
}

export interface SmartInboxApi {
  review?: ReviewApi
  listSenders(query: Partial<SenderListQuery>): Promise<SenderList>
  decideSender(input: SenderDecision): Promise<OwnerActionStatus>
  reviewFilter?(input: FilterReviewInput): Promise<OwnerActionStatus>
  filterThread?(threadId: string, actionId: string): Promise<OwnerActionStatus>
  restoreFiltered?(threadId: string, actionId: string): Promise<OwnerActionStatus>
  editOwnerReason?(
    actionId: string,
    input: import('@amc/protocol').OwnerActionReasonInput,
  ): Promise<{ reason: string | null; reasonRevision: string }>
  adoptScreenedDestination(
    input: AdoptScreenedDestination,
  ): Promise<{ accountId: string; providerId: string }>
  ownerAction(id: string, includeReason?: boolean): Promise<OwnerActionStatus>
  undoOwnerAction(id: string): Promise<OwnerActionStatus>
  triageHistory?(query: {
    before?: number
    includeReasons?: '1'
  }): Promise<import('@amc/protocol').TriageHistoryPage>
  forgetTriageDecision?(id: string): Promise<import('@amc/protocol').TriageForgetResult | null>
  exportTriageHistory?(input: import('@amc/protocol').TriageExportInput): Promise<boolean>
  triageQueue(query: TriageQueueRequest): Promise<TriageQueuePage>
  resolveSenderAvatars(
    input: SenderAvatarResolve,
    knownDigests?: readonly string[],
  ): Promise<DesktopSenderAvatarResults>
}

export interface DesktopLogSettings {
  debug: boolean
  effectiveLevel: Level
}

export interface AmcApi {
  reportFailure?(report: RendererLogReport): void
  logSettings?(): Promise<DesktopLogSettings>
  setDebugLogging?(enabled: boolean): Promise<DesktopLogSettings>
  copyDiagnostics(): Promise<void>
  onCopyDiagnostics(listener: () => void): () => void
  feedback: FeedbackApi
  smartInbox?: SmartInboxApi
  notificationSettings(): Promise<NotificationSettings>
  saveNotificationSettings(settings: NotificationSettings): Promise<void>
  onOpenSettings(listener: () => void): () => void
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
  threads(query: ThreadQuery): Promise<DesktopThreadSummary[]>
  thread(id: string): Promise<ThreadWithMessages | null>
  summaries(ids: string[]): Promise<DesktopThreadSummary[]>
  /** Instant local filter over subject, people and snippet. */
  filter(text: string, accountId: string | null): Promise<DesktopThreadSummary[]>
  /** Full-text search over the entire history, on the Engine. */
  search(text: string, accountId: string | null): Promise<SearchHit[]>
  contacts(text: string): Promise<Contact[]>
  startCompose(input: ComposeStart): Promise<ComposeDraft>
  composeDrafts(): Promise<VersionedDraft[]>
  composeDraft(id: string): Promise<ComposeDraft>
  composeDraftByMessage(messageId: string, imapRevision?: string): Promise<ComposeDraft>
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
  cachedMessageHtml(messageId: string): Promise<string | null>
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
