/** The subset of Gmail API resources AMC uses. https://developers.google.com/gmail/api/reference/rest */

export interface GmailProfile {
  emailAddress: string
  messagesTotal: number
  threadsTotal: number
  historyId: string
}

export interface GmailLabel {
  id: string
  name: string
  type: 'system' | 'user'
  color?: { backgroundColor?: string; textColor?: string }
}

export interface GmailHeader {
  name: string
  value: string
}

export interface GmailPart {
  partId?: string
  mimeType: string
  filename?: string
  headers?: GmailHeader[]
  body?: { size: number; data?: string; attachmentId?: string }
  parts?: GmailPart[]
}

export interface GmailMessage {
  id: string
  threadId: string
  labelIds?: string[]
  snippet?: string
  historyId?: string
  internalDate?: string
  sizeEstimate?: number
  payload?: GmailPart
}

export type GmailMessageState = Pick<GmailMessage, 'labelIds' | 'historyId'>

export interface GmailMessageRef {
  id: string
  threadId: string
  labelIds?: string[]
}

export interface GmailListMessages {
  messages?: GmailMessageRef[]
  nextPageToken?: string
  resultSizeEstimate?: number
}

export interface GmailHistoryRecord {
  id: string
  messagesAdded?: { message: GmailMessageRef }[]
  messagesDeleted?: { message: GmailMessageRef }[]
  labelsAdded?: { message: GmailMessageRef; labelIds: string[] }[]
  labelsRemoved?: { message: GmailMessageRef; labelIds: string[] }[]
}

export interface GmailHistoryList {
  history?: GmailHistoryRecord[]
  nextPageToken?: string
  historyId: string
}

/** Everything the sync needs from Gmail; the HTTP client and the test fake both implement it. */
export interface GmailApi {
  profile(): Promise<GmailProfile>
  labels(): Promise<GmailLabel[]>
  listMessages(options: {
    pageToken?: string
    q?: string
    maxResults?: number
  }): Promise<GmailListMessages>
  /** `urgent` = live sync: served before backfill under the quota. */
  getMessage(id: string, urgent?: boolean): Promise<GmailMessage | null>
  getMessageState(id: string, writeback?: boolean): Promise<GmailMessageState | null>
  getThreadMessages(id: string): Promise<GmailMessage[]>
  modifyMessage(
    id: string,
    addLabelIds: string[],
    removeLabelIds: string[],
  ): Promise<GmailMessageState>
  setTrashed(id: string, trashed: boolean): Promise<GmailMessageState>
  createLabel(name: string): Promise<GmailLabel>
  history(
    startHistoryId: string,
    pageToken?: string,
    writeback?: boolean,
  ): Promise<GmailHistoryList | null>
  attachment(messageId: string, attachmentId: string): Promise<Uint8Array>
  /** Creates or replaces a draft from a raw RFC 5322 message; returns the draft and its message. */
  saveDraft(input: { draftId?: string; raw: string; threadId?: string }): Promise<GmailDraft>
  listDrafts(pageToken?: string): Promise<{ drafts?: GmailDraft[]; nextPageToken?: string }>
  getDraft(id: string): Promise<GmailDraft | null>
  sendMessage(input: { raw: string; threadId?: string }): Promise<GmailMessageRef>
  deleteDraft(draftId: string): Promise<void>
}

export interface GmailDraft {
  id: string
  message: GmailMessageRef
}
