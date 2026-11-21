import { z } from 'zod'

export const Address = z.object({ name: z.string().nullable(), address: z.string() })
export type Address = z.infer<typeof Address>

export const ACCOUNT_STATUSES = ['new', 'backfilling', 'ready', 'error', 'auth_expired'] as const
export type AccountStatus = (typeof ACCOUNT_STATUSES)[number]

export const AccountSummary = z.object({
  id: z.string(),
  kind: z.enum(['gmail', 'imap']),
  address: z.string(),
  displayName: z.string().nullable(),
  status: z.enum(ACCOUNT_STATUSES),
  lastSyncAt: z.number().nullable(),
  lastError: z.string().nullable(),
  messageCount: z.number(),
  backfill: z.object({
    phase: z.enum(['recent', 'all', 'done']).nullable(),
    fetched: z.number(),
    estimatedTotal: z.number().nullable(),
  }),
})
export type AccountSummary = z.infer<typeof AccountSummary>

export const Label = z.object({
  id: z.string(),
  accountId: z.string(),
  providerId: z.string(),
  name: z.string(),
  kind: z.enum(['system', 'user']),
  color: z.string().nullable(),
})
export type Label = z.infer<typeof Label>

export const ThreadSummary = z.object({
  id: z.string(),
  accountId: z.string(),
  subject: z.string(),
  snippet: z.string(),
  participants: z.array(Address),
  messageCount: z.number(),
  unreadCount: z.number(),
  starred: z.boolean(),
  inInbox: z.boolean(),
  hasAttachments: z.boolean(),
  labelIds: z.array(z.string()),
  lastMessageAt: z.number(),
})
export type ThreadSummary = z.infer<typeof ThreadSummary>

export const AttachmentSummary = z.object({
  id: z.string(),
  filename: z.string(),
  mimeType: z.string(),
  size: z.number(),
  inline: z.boolean(),
  contentId: z.string().nullable(),
})
export type AttachmentSummary = z.infer<typeof AttachmentSummary>

export const MessageDetail = z.object({
  id: z.string(),
  threadId: z.string(),
  accountId: z.string(),
  rfcMessageId: z.string().nullable(),
  inReplyTo: z.string().nullable(),
  from: Address.nullable(),
  to: z.array(Address),
  cc: z.array(Address),
  bcc: z.array(Address),
  replyTo: z.array(Address),
  subject: z.string(),
  snippet: z.string(),
  bodyText: z.string(),
  bodySearchTruncated: z.boolean().optional(),
  hasHtml: z.boolean(),
  sentAt: z.number(),
  unread: z.boolean(),
  starred: z.boolean(),
  labelIds: z.array(z.string()),
  listUnsubscribe: z.string().nullable(),
  attachments: z.array(AttachmentSummary),
})
export type MessageDetail = z.infer<typeof MessageDetail>

export const ThreadDetail = ThreadSummary.extend({ messages: z.array(MessageDetail) })
export type ThreadDetail = z.infer<typeof ThreadDetail>

export const ThreadList = z.object({
  threads: z.array(ThreadSummary),
  /** Pass as `before` to get the next page; null at the end. */
  nextBefore: z.number().nullable(),
})
export type ThreadList = z.infer<typeof ThreadList>

export const SearchHit = ThreadSummary.extend({ matchSnippet: z.string() })
export type SearchHit = z.infer<typeof SearchHit>

export const GmailAuthStart = z.object({ redirectUri: z.string().url() })
export const GmailAuthStartResponse = z.object({ authUrl: z.string().url(), state: z.string() })
export type GmailAuthStartResponse = z.infer<typeof GmailAuthStartResponse>
export const GmailAuthComplete = z.object({ code: z.string().min(1), state: z.string().min(1) })

const MailServerLogin = z.object({
  host: z.hostname(),
  port: z.number().int().min(1).max(65535),
  tls: z.enum(['implicit', 'starttls']),
  username: z.string().min(1).max(512),
  password: z.string().min(1).max(4096),
})

export const ImapAccountInput = z.object({
  address: z.email().transform((address) => address.toLowerCase()),
  imap: MailServerLogin,
  smtp: MailServerLogin,
  smtpSavesSent: z.boolean().default(false),
})
export type ImapAccountInput = z.infer<typeof ImapAccountInput>

export interface ImapAccountAdded {
  accountId: string
  address: string
  created: boolean
}

export const Draft = z.object({
  id: z.string(),
  accountId: z.string(),
  threadId: z.string().nullable(),
  from: z.string(),
  to: z.array(Address),
  cc: z.array(Address),
  bcc: z.array(Address),
  subject: z.string(),
  body: z.string(),
  lastAuthor: z.string(),
  updatedAt: z.number(),
})
export type Draft = z.infer<typeof Draft>

export const Contact = z.object({
  address: z.string(),
  name: z.string().nullable(),
  lastSeenAt: z.number(),
  receivedCount: z.number(),
  sentCount: z.number(),
})
export type Contact = z.infer<typeof Contact>

/** Entities a replica holds, keyed the same in snapshots and changes. */
export const SYNC_ENTITIES = ['account', 'label', 'thread', 'message', 'draft'] as const
export type SyncEntity = (typeof SYNC_ENTITIES)[number]

export type SyncData = {
  account: AccountSummary
  label: Label
  thread: ThreadSummary
  message: MessageDetail
  draft: Draft
}

export type SyncChange = {
  [E in SyncEntity]:
    | { modseq: number; entity: E; id: string; op: 'upsert'; data: SyncData[E] }
    | { modseq: number; entity: E; id: string; op: 'delete' }
}[SyncEntity]

export interface SyncState {
  /** The newest change; follow changes from here after a snapshot. */
  modseq: number
  /** Asking for changes older than this answers `resync_required`. */
  oldestModseq: number
}

export interface SyncChanges {
  changes: SyncChange[]
  /** Ask again with since = this. */
  modseq: number
  more: boolean
}

export interface SyncSnapshotPage<E extends SyncEntity = SyncEntity> {
  entity: E
  rows: SyncData[E][]
  cursor: string | null
}
