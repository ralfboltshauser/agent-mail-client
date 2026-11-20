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
