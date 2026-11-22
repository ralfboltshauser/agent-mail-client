import type { SenderAvatarResolve } from '@amc/protocol'
import type { DesktopSenderAvatarResults, SmartInboxApi } from '../../../../shared/api'

type Message = SenderAvatarResolve['messages'][number]
type Listener = () => void
type Resolve = SmartInboxApi['resolveSenderAvatars']
type WatchPairing = (reset: Listener) => (() => void) | undefined
interface VisibleAvatar {
  key: string
  message: Message
  listeners: Set<Listener>
  digest: string | null
  image: string | null
  due: number
  attempts: number
}

const batchSize = 100
const imagePrefix = 'data:image/png;base64,'
const key = ({ accountId, messageId }: Message) => JSON.stringify([accountId, messageId])

/** Owns only mounted image subscriptions. Main owns the bounded byte cache. */
export class SenderAvatarCache {
  readonly #visible = new Map<string, VisibleAvatar>()
  readonly #resolve: Resolve
  readonly #watchPairing?: WatchPairing
  #stopPairing?: () => void
  #timer: ReturnType<typeof setTimeout> | undefined
  #inFlight = false
  #generation = 0

  constructor(resolve: Resolve, watchPairing?: WatchPairing) {
    this.#resolve = resolve
    this.#watchPairing = watchPairing
  }

  image(message: Message): string | null {
    return this.#visible.get(key(message))?.image ?? null
  }

  subscribe(message: Message, listener: Listener): () => void {
    const id = key(message)
    if (!this.#visible.size) this.#stopPairing = this.#watchPairing?.(() => this.reset())
    let entry = this.#visible.get(id)
    if (!entry) {
      entry = {
        key: id,
        message,
        listeners: new Set(),
        digest: null,
        image: null,
        due: Date.now(),
        attempts: 0,
      }
      this.#visible.set(id, entry)
      this.#schedule()
    }
    entry.listeners.add(listener)
    return () => {
      entry.listeners.delete(listener)
      if (!entry.listeners.size) this.#visible.delete(id)
      if (!this.#visible.size) {
        this.#stopPairing?.()
        this.#stopPairing = undefined
        this.#schedule()
      }
    }
  }

  /** Drop old pixels and ignore older replies when the pairing changes. */
  reset(): void {
    this.#generation++
    for (const entry of this.#visible.values()) {
      entry.attempts = 0
      entry.due = Date.now()
      this.#publish(entry, null, null)
    }
    this.#schedule()
  }

  #schedule(): void {
    clearTimeout(this.#timer)
    if (this.#inFlight || !this.#visible.size) return
    let next = Infinity
    for (const entry of this.#visible.values()) next = Math.min(next, entry.due)
    this.#timer = setTimeout(() => void this.#flush(), Math.max(16, next - Date.now()))
  }

  async #flush(): Promise<void> {
    const now = Date.now()
    const selected: VisibleAvatar[] = []
    for (const entry of this.#visible.values()) {
      if (entry.due <= now) selected.push(entry)
      if (selected.length === batchSize) break
    }
    if (!selected.length) return this.#schedule()
    this.#inFlight = true
    const generation = this.#generation
    try {
      const known = Array.from(new Set(selected.flatMap(({ digest }) => (digest ? [digest] : []))))
      const reply = await this.#resolve({ messages: selected.map(({ message }) => message) }, known)
      if (generation === this.#generation) this.#apply(selected, reply)
    } catch {
      if (generation === this.#generation) this.#apply(selected, { rows: [] })
    } finally {
      this.#inFlight = false
      this.#schedule()
    }
  }

  #apply(selected: VisibleAvatar[], reply: DesktopSenderAvatarResults): void {
    const rows = new Map(reply.rows.map((row) => [key(row), row]))
    const known = new Map(
      selected.flatMap(({ digest, image }) => (digest && image ? [[digest, image]] : [])),
    )
    for (const entry of selected) {
      if (this.#visible.get(entry.key) !== entry) continue
      const row = rows.get(entry.key)
      const digest = row?.source !== 'initials' ? (row?.digest ?? null) : null
      const image = digest ? (row?.image === undefined ? known.get(digest) : row.image) : null
      const safeImage = image?.startsWith(imagePrefix) ? image : null
      entry.due = Date.now() + (++entry.attempts <= 2 && !safeImage ? 5_000 : 60_000)
      this.#publish(entry, safeImage ? digest : null, safeImage)
    }
  }

  #publish(entry: VisibleAvatar, digest: string | null, image: string | null): void {
    entry.digest = digest
    if (entry.image === image) return
    entry.image = image
    for (const listener of entry.listeners) listener()
  }
}

export const senderAvatarCache = new SenderAvatarCache(
  (input, known) =>
    window.amc?.smartInbox?.resolveSenderAvatars(input, known) ?? Promise.resolve({ rows: [] }),
  (reset) => {
    let engineUrl: string | null | undefined
    return window.amc?.onStatus(({ phase, engineUrl: nextUrl }) => {
      const next = ['unpaired', 'restoring-pairing', 'pairing-read-error'].includes(phase)
        ? null
        : nextUrl
      if (engineUrl !== next && (engineUrl !== undefined || next === null)) reset()
      engineUrl = next
    })
  },
)
