import type {
  AccountSummary,
  Contact,
  Draft,
  Label,
  MessageDetail,
  SearchHit,
  ThreadSummary,
} from '@amc/protocol'

/** Which Threads a list shows. */
export type View =
  | { kind: 'inbox' }
  | { kind: 'unread' }
  | { kind: 'starred' }
  | { kind: 'sent' }
  | { kind: 'drafts' }
  | { kind: 'all' }
  | { kind: 'label'; labelId: string }

export interface ThreadQuery {
  view: View
  accountId: string | null
  limit?: number
}

export interface ThreadWithMessages {
  thread: ThreadSummary
  messages: MessageDetail[]
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
  engineUrl: string | null
  /** Bootstrap progress, 0..1. */
  progress: number | null
  lastSyncAt: number | null
  error: string | null
}

/** Everything the renderer may ask of the main process. Exposed as `window.amc`. */
export interface AmcApi {
  pair(engineUrl: string, code: string): Promise<void>
  unpair(): Promise<void>
  status(): Promise<SyncStatus>
  syncNow(): Promise<void>

  accounts(): Promise<AccountSummary[]>
  labels(accountId: string | null): Promise<Label[]>
  counts(accountId: string | null): Promise<Counts>
  threads(query: ThreadQuery): Promise<ThreadSummary[]>
  thread(id: string): Promise<ThreadWithMessages | null>
  /** Instant local filter over subject, people and snippet. */
  filter(text: string, accountId: string | null): Promise<ThreadSummary[]>
  /** Full-text search over the entire history, on the Engine. */
  search(text: string, accountId: string | null): Promise<SearchHit[]>
  contacts(text: string): Promise<Contact[]>
  messageHtml(messageId: string): Promise<string | null>
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
