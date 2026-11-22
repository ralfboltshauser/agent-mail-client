import type { MessageDetail, SyncChange } from '@amc/protocol'
import type { NotificationSettings } from '../shared/api'
import type { Replica } from './replica'

type Message = Omit<MessageDetail, 'bodyText'>
type Candidate = Pick<Message, 'id' | 'threadId'> & { key: string }

const RECENT_ARRIVAL_MS = 10 * 60 * 1000

function arrivalTime(message: Message): number {
  // Old replica rows can lack provider delivery time. Treat those as historical.
  return message.deliveredAt ?? Number.NEGATIVE_INFINITY
}

function messageIdentity(message: Message): string | undefined {
  return message.rfcMessageId?.trim().replace(/^<|>$/g, '') || undefined
}

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
  now = Date.now(),
): Candidate[] {
  const accounts = new Map(replica.accounts().map(({ id, address }) => [id, address]))
  for (const change of changes) {
    if (change.entity !== 'account') continue
    if (change.op === 'upsert') accounts.set(change.id, change.data.address)
    else accounts.delete(change.id)
  }
  const owners = new Set([...accounts.values()].map((address) => address.toLowerCase()))
  const exists = replica.db.prepare('SELECT 1 FROM message WHERE id = ?')
  const notified = replica.db.prepare(
    'SELECT 1 FROM notified_message WHERE account_id = ? AND message_id = ?',
  )
  return changes.flatMap((change) => {
    if (change.entity !== 'message' || change.op !== 'upsert') return []
    const message = change.data
    const age = now - arrivalTime(message)
    const identity = messageIdentity(message)
    if (
      age < 0 ||
      age > RECENT_ARRIVAL_MS ||
      !isInboxUnread(message) ||
      (message.from && owners.has(message.from.address.toLowerCase())) ||
      exists.get(message.id) ||
      (identity && notified.get(message.accountId, identity))
    ) {
      return []
    }
    const key = identity ? JSON.stringify([message.accountId, identity]) : message.id
    return [{ id: message.id, threadId: message.threadId, key }]
  })
}

export function notificationMessage(replica: Replica, candidate: Candidate): Message | null {
  const [thread] = replica.summaries([candidate.threadId])
  if (!thread?.inInbox || thread.muted || !thread.unreadCount) return null
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
      if (!thread?.muted) this.#pending.set(candidate.key, candidate)
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
    if (messages.length === 0) return
    const remember = this.#replica.db.prepare(
      'INSERT OR IGNORE INTO notified_message (account_id, message_id) VALUES (?, ?)',
    )
    if (settings.showSnippet && messages.length > 3) {
      const latest = messages.reduce((a, b) => (arrivalTime(a) > arrivalTime(b) ? a : b))
      this.#show({ title: `${messages.length} new messages`, threadId: latest.threadId })
    } else {
      for (const message of messages) {
        const sender = message.from?.name || message.from?.address || 'Unknown sender'
        this.#show(
          settings.showSnippet
            ? {
                title: sender,
                subtitle: message.subject || '(No subject)',
                body: message.snippet,
                threadId: message.threadId,
              }
            : { title: `New message from ${sender}`, threadId: message.threadId },
        )
      }
    }
    for (const message of messages) {
      const identity = messageIdentity(message)
      if (identity) remember.run(message.accountId, identity)
    }
  }
}
