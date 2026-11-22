export const feedbackShortcut = '⌘⇧F'
export const feedbackAccelerator = 'CommandOrControl+Shift+F'

const views = [
  'inbox',
  'unread',
  'starred',
  'sent',
  'outbox',
  'drafts',
  'all',
  'snoozed',
  'trash',
  'bucket',
  'label',
  'search',
  'filter',
  'triage',
  'composer',
  'settings',
  'setup',
] as const

export function feedbackView(value: unknown) {
  return views.find((view) => view === value) ?? 'unknown'
}

export interface FeedbackDraft {
  text: string
  markdown: string
}

export interface FeedbackApi {
  onOpen(listener: () => void): () => void
  capture(view: string): Promise<{ id: string }>
  send(id: string, draft: FeedbackDraft): Promise<{ opened: boolean }>
  release(id: string): Promise<void>
  copy(id: string, draft: FeedbackDraft): Promise<void>
}
