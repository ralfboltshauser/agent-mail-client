import type { MessageDetail, SyncChange, ThreadSummary } from '@amc/protocol'
import type { NotificationSettings } from '../shared/api'
import type { Replica } from './replica'

type Message = Omit<MessageDetail, 'bodyText'>
type Candidate = Pick<Message, 'id' | 'threadId'>

export const DEFAULT_NOTIFICATION_SETTINGS: NotificationSettings = {
  enabled: true,
  showSnippet: true,
  quietStart: '',
  quietEnd: '',
}

export function parseNotificationSettings(input: unknown): NotificationSettings {
  const settings = input as Partial<NotificationSettings> | null
  const time = /^(?:[01]\d|2[0-3]):[0-5]\d$/
  if (
    typeof settings?.enabled !== 'boolean' ||
    typeof settings.showSnippet !== 'boolean' ||
    typeof settings.quietStart !== 'string' ||
    typeof settings.quietEnd !== 'string' ||
    !(
      (settings.quietStart === '' && settings.quietEnd === '') ||
      (time.test(settings.quietStart) && time.test(settings.quietEnd))
    )
  ) {
    throw new Error('Enter both quiet hours times or clear both')
  }
  const { enabled, showSnippet, quietStart, quietEnd } = settings
  return { enabled, showSnippet, quietStart, quietEnd }
}

export function inQuietHours({ quietStart, quietEnd }: NotificationSettings, now: Date): boolean {
  if (!quietStart || !quietEnd || quietStart === quietEnd) return false
  const minutes = (time: string) => Number(time.slice(0, 2)) * 60 + Number(time.slice(3))
  const start = minutes(quietStart)
  const end = minutes(quietEnd)
  const current = now.getHours() * 60 + now.getMinutes()
  return start < end ? current >= start && current < end : current >= start || current < end
}

function isInboxUnread(message: Message): boolean {
  const prefix = `${message.accountId}:`
  return (
    message.unread &&
    message.labelIds.includes(`${prefix}INBOX`) &&
    !message.labelIds.includes(`${prefix}TRASH`) &&
    !message.labelIds.includes(`${prefix}SPAM`) &&
    !message.labelIds.includes(`${prefix}SENT`)
  )
}

/** Read before applying the page. A label or read-state change on an existing message is an upsert too. */
export function newInboxMessages(
  replica: Replica,
  changes: SyncChange[],
  startedAt: number,
): Candidate[] {
  // The replica has the provider message timestamp but no separate arrival timestamp.
  const accounts = replica.accounts()
  const ready = new Set(
    accounts.filter(({ backfill }) => backfill.phase === 'done').map(({ id }) => id),
  )
  const owners = new Set(accounts.map(({ address }) => address.toLowerCase()))
  const exists = replica.db.prepare('SELECT 1 FROM message WHERE id = ?')
  return changes.flatMap((change) => {
    if (change.entity !== 'message' || change.op !== 'upsert') return []
    const message = change.data
    if (
      message.sentAt <= startedAt ||
      !ready.has(message.accountId) ||
      !isInboxUnread(message) ||
      (message.from && owners.has(message.from.address.toLowerCase())) ||
      exists.get(message.id)
    ) {
      return []
    }
    return [{ id: message.id, threadId: message.threadId }]
  })
}

export function isInterrupt(_thread: ThreadSummary): boolean {
  return true
}

export function notificationMessage(replica: Replica, candidate: Candidate): Message | null {
  const [thread] = replica.summaries([candidate.threadId])
  if (!thread?.inInbox || thread.muted || !thread.unreadCount || !isInterrupt(thread)) return null
  const row = replica.db.prepare('SELECT data FROM message WHERE id = ?').get(candidate.id) as
    | { data: string }
    | undefined
  if (!row) return null
  const message: Message = JSON.parse(row.data)
  return message.threadId === thread.id && isInboxUnread(message) ? message : null
}

interface Notice {
  title: string
  subtitle?: string
  body?: string
  threadId: string
}

export class NewMailNotifications {
  readonly #replica: Replica
  readonly #settings: () => NotificationSettings
  readonly #show: (notice: Notice) => void
  #pending = new Map<string, Candidate>()
  #timer: ReturnType<typeof setTimeout> | undefined

  constructor(
    replica: Replica,
    settings: () => NotificationSettings,
    show: (notice: Notice) => void,
  ) {
    this.#replica = replica
    this.#settings = settings
    this.#show = show
  }

  add(candidates: Candidate[]): void {
    const settings = this.#settings()
    if (!settings.enabled || inQuietHours(settings, new Date())) return
    for (const candidate of candidates) {
      const [thread] = this.#replica.summaries([candidate.threadId])
      if (!thread?.muted) this.#pending.set(candidate.id, candidate)
    }
    if (this.#pending.size && !this.#timer) this.#timer = setTimeout(() => this.#flush(), 10_000)
  }

  clear(): void {
    clearTimeout(this.#timer)
    this.#timer = undefined
    this.#pending.clear()
  }

  #flush(): void {
    const candidates = [...this.#pending.values()]
    this.clear()
    const settings = this.#settings()
    if (!settings.enabled || inQuietHours(settings, new Date())) return
    const messages = candidates
      .map((candidate) => notificationMessage(this.#replica, candidate))
      .filter((message) => message !== null)
    if (messages.length > 3) {
      const latest = messages.reduce((a, b) => (a.sentAt > b.sentAt ? a : b))
      this.#show({ title: `${messages.length} new messages`, threadId: latest.threadId })
      return
    }
    for (const message of messages) {
      this.#show({
        title: message.from?.name || message.from?.address || 'Unknown sender',
        subtitle: message.subject || '(No subject)',
        body: settings.showSnippet ? message.snippet : undefined,
        threadId: message.threadId,
      })
    }
  }
}
