import { toast } from 'sonner'
import { getAmc } from '@/lib/amc'
import {
  canUndo,
  loadReview,
  poll,
  type SavedReview,
  saveReview,
  statusLabel,
  submit,
  undo,
} from './journal'
import { type Decision, type Preview, type ReviewAction, reviewError, sameTarget } from './model'
import { loadPreview } from './preview'

export class ReviewStore {
  #saved: SavedReview | null = null
  #account = ''
  #active = false
  #read = 0
  #replicaVersion = 0
  #working = false
  #retryBatch = false
  #polling = false
  #listeners = new Set<() => void>()
  #next: { batch: string; index: number; preview: Preview } | null = null
  #api = getAmc()
  #smart = this.#api.smartInbox
  #view = {
    card: null as Preview | null,
    progress: '',
    busy: false,
    error: null as string | null,
    notice: '',
    finished: false,
    more: false,
    history: [] as ReviewAction[],
    storageError: false,
  }

  subscribe = (listener: () => void) => {
    this.#listeners.add(listener)
    return () => this.#listeners.delete(listener)
  }

  read = () => this.#view

  #publish(patch: Partial<ReviewStore['view']>) {
    this.#view = { ...this.#view, ...patch }
    for (const listener of this.#listeners) listener()
  }

  get view() {
    return this.#view
  }
  get #session() {
    return this.#saved?.sessions[this.#account]
  }
  get #history() {
    return this.#saved?.history ?? []
  }

  #save() {
    if (!this.#saved) return
    try {
      saveReview(this.#saved)
    } catch {
      this.#publish({ storageError: true })
    }
  }

  async restore() {
    if (!this.#smart || this.#saved) return
    const scope = await this.#smart.reviewPairing()
    if (!this.#saved) this.#saved = loadReview(scope)
    this.#publish({ history: this.#history })
  }

  async #ownerApi() {
    const smart = this.#smart
    if (!smart || !this.#saved || (await smart.reviewPairing()) !== this.#saved.scope) {
      throw new Error('The Engine pairing changed. Open triage again.')
    }
    return smart
  }

  open(accountId: string | null) {
    this.#retryBatch = false
    this.#account = JSON.stringify(accountId)
    this.#active = true
    this.#publish({
      card: null,
      error: null,
      progress: '',
      finished: false,
      more: false,
      notice: '',
    })
    void this.restore()
      .then(() => {
        if (this.#active && this.#account === JSON.stringify(accountId)) {
          const session = this.#session
          void this.refresh(!!session && session.index >= session.ids.length && !session.cursor)
        }
      })
      .catch((error) => {
        if (this.#active && this.#account === JSON.stringify(accountId)) {
          this.#publish({ busy: false, error: reviewError(error) })
        }
      })
  }

  close() {
    this.#active = false
    this.#read++
    this.#next = null
  }

  replicaChanged() {
    this.#replicaVersion++
    this.#next = null
    void this.poll()
  }

  async refresh(newBatch = this.#retryBatch) {
    this.#retryBatch = newBatch
    const generation = ++this.#read
    this.#next = null
    this.#publish({ busy: true, error: null })
    try {
      await this.restore()
      const smart = await this.#ownerApi()
      if (generation !== this.#read) return
      if (!this.#session || newBatch) {
        const accountId = JSON.parse(this.#account) as string | null
        const cursor = newBatch ? this.#session?.cursor : undefined
        const page = await smart.triageQueue({
          accountId: accountId ?? undefined,
          limit: 100,
          ...(cursor ? { cursor, nextBatch: '1' } : {}),
        })
        if (generation !== this.#read || !this.#saved) return
        if (!page.reviewLookup) throw new Error('Update the Engine to use desktop triage review.')
        this.#retryBatch = false
        this.#saved.sessions[this.#account] = {
          batch: crypto.randomUUID(),
          ids: page.cards.map(({ id }) => id),
          index: 0,
          cursor: page.cursor,
        }
        this.#save()
      }
      await this.#display(generation)
    } catch (error) {
      if (generation === this.#read) this.#publish({ busy: false, error: reviewError(error) })
    }
  }

  async #display(generation: number, cached?: Preview) {
    const session = this.#session
    if (!session || !this.#smart || !this.#active) return
    let notice = this.#view.notice
    for (let index = session.index; index < session.ids.length; index++) {
      const preview =
        cached ??
        (await loadPreview(
          this.#api,
          this.#smart,
          session.ids[index],
          this.#history,
          session.batch,
        ))
      if (generation !== this.#read) return
      if (preview) {
        session.index = index
        this.#save()
        this.#publish({
          card: preview,
          progress: `${index + 1}/${session.ids.length}`,
          finished: false,
          more: false,
          busy: false,
          error: null,
          notice,
        })
        this.#preload(session.batch, index + 1)
        return
      }
      notice = 'A card changed and is no longer eligible for review.'
    }
    session.index = session.ids.length
    this.#save()
    this.#publish({
      card: null,
      progress: `${session.ids.length}/${session.ids.length}`,
      finished: true,
      more: !!session.cursor,
      busy: false,
      error: null,
      notice,
    })
  }

  #preload(batch: string, index: number) {
    const id = this.#session?.ids[index]
    const generation = this.#read
    const replicaVersion = this.#replicaVersion
    if (!id || !this.#smart) return
    void loadPreview(this.#api, this.#smart, id, this.#history, batch)
      .then((preview) => {
        if (preview && generation === this.#read && replicaVersion === this.#replicaVersion)
          this.#next = { batch, index, preview }
      })
      .catch(() => {})
  }

  #update(action: ReviewAction, patch: Partial<ReviewAction>) {
    const updated = { ...action, ...patch }
    const saved = this.#saved
    if (!saved) return updated
    saved.history = saved.history.some(({ id }) => id === action.id)
      ? saved.history.map((entry) => (entry.id === action.id ? updated : entry))
      : [...saved.history, updated]
    this.#save()
    this.#publish({ history: saved.history })
    return updated
  }

  async #advance(action: ReviewAction, keepGroup: boolean) {
    const session = this.#sessionFor(action)
    if (!session || session.index !== action.index) return
    if (!keepGroup) session.index++
    this.#save()
    if (!this.#active || session !== this.#session) return
    const cached =
      this.#next?.batch === session.batch && this.#next.index === session.index
        ? this.#next.preview
        : undefined
    const generation = ++this.#read
    this.#next = null
    if (!cached && session.ids[session.index]) this.#publish({ busy: true })
    try {
      await this.#display(generation, cached)
    } catch (error) {
      if (generation === this.#read) this.#publish({ busy: false, error: reviewError(error) })
    }
  }

  #entry(card: Preview, id: string, decision: Decision, label: string): ReviewAction | null {
    const session = this.#session
    if (!session || !this.#active || this.#view.card !== card) return null
    return {
      id,
      batch: session.batch,
      index: session.index,
      card: card.id,
      accountId: card.accountId,
      threadId: card.threadId,
      messageId: card.messageId,
      label,
      decision,
      status: 'unconfirmed',
      error: null,
    }
  }

  async validate(card: Preview) {
    const smart = await this.#ownerApi()
    const current = await loadPreview(
      this.#api,
      smart,
      card.id,
      this.#history,
      this.#session?.batch ?? '',
    )
    if (this.#view.card !== card || !this.#active || !current || !sameTarget(card, current)) {
      throw new Error('This card changed. Refresh it before making a decision.')
    }
    return current
  }

  decide = async (card: Preview, id: string, decision: Decision, label: string) => {
    const action = this.#entry(card, id, decision, label)
    if (!action || this.#working || this.#view.busy || this.#view.error) return
    if (decision.kind === 'skip') {
      this.#update(action, { status: 'applied' })
      void this.#advance(action, false)
      return
    }
    const generation = this.#read
    this.#working = true
    this.#publish({ busy: true })
    try {
      await this.validate(card)
      if (generation !== this.#read || this.#view.card !== card) return
      await this.#submit(action)
    } catch (error) {
      if (generation === this.#read) this.#publish({ error: reviewError(error) })
    } finally {
      this.#working = false
      if (generation === this.#read) this.#publish({ busy: false })
    }
  }

  async #submit(action: ReviewAction) {
    const smart = await this.#ownerApi()
    this.#update(action, { status: 'unconfirmed', error: null })
    try {
      const result = await submit(smart, action)
      const updated = this.#update(action, { status: result.status, error: result.error })
      this.#announce(updated, true)
      if (result.status === 'applied' || result.status === 'pending') {
        await this.#advance(
          updated,
          action.card.kind === 'sender' && action.decision.kind !== 'sender',
        )
      }
    } catch (error) {
      this.#announce(this.#update(action, { status: 'unconfirmed', error: reviewError(error) }))
    }
  }

  async retryAction(action: ReviewAction) {
    if (this.#working) return
    if (action.status !== 'unconfirmed' || !action.error) {
      this.#returnTo(action)
      return
    }
    this.#working = true
    try {
      await this.#submit(action)
    } catch (error) {
      this.#announce(this.#update(action, { error: reviewError(error) }))
    } finally {
      this.#working = false
    }
  }

  #returnTo(action: ReviewAction) {
    const session = this.#sessionFor(action)
    if (!session) return
    session.index = action.index
    this.#save()
    if (this.#active && session === this.#session) void this.refresh(false)
  }

  #sessionFor(action: ReviewAction) {
    return Object.values(this.#saved?.sessions ?? {}).find(
      (session) => session.batch === action.batch,
    )
  }

  recordReply(
    card: Preview,
    id: string,
    decision: Extract<Decision, { kind: 'reply' }>,
    queued: boolean,
  ) {
    const action = this.#entry(card, id, decision, 'Reply')
    if (!action) return
    const updated = this.#update(action, { status: queued ? 'pending' : 'applied' })
    void this.#advance(updated, card.id.kind === 'sender')
  }

  replyCancelled(id: string) {
    const action = this.#history.find((entry) => entry.id === id)
    if (!action || action.status === 'undone') return
    this.#update(action, { status: 'undone' })
    this.#returnTo(action)
  }

  latestUndo() {
    return this.#history.findLast((action) => this.#inAccount(action) && canUndo(action))
  }

  #inAccount(action: ReviewAction) {
    return this.#account === 'null' || this.#account === JSON.stringify(action.accountId)
  }

  async undoAction(action: ReviewAction) {
    const latest = this.#history.find(({ id }) => id === action.id)
    if (this.#working || !latest || !canUndo(latest)) return
    action = latest
    this.#working = true
    const id = action.undo?.status === 'unconfirmed' ? action.undo.id : crypto.randomUUID()
    try {
      const smart = await this.#ownerApi()
      this.#update(action, { undo: { id, status: 'unconfirmed', error: null } })
      const result = await undo(this.#api, smart, action, id)
      this.#acceptStatus(action, { undo: { id, ...result } })
    } catch (error) {
      this.#announce(
        this.#update(action, { undo: { id, status: 'unconfirmed', error: reviewError(error) } }),
      )
    } finally {
      this.#working = false
    }
  }

  #acceptStatus(action: ReviewAction, patch: Partial<ReviewAction>) {
    const undone = patch.undo?.status === 'applied'
    const updated = this.#update(
      action,
      undone ? { ...patch, status: 'undone', error: null } : patch,
    )
    this.#announce(updated)
    if (undone) this.#returnTo(action)
  }

  #announce(action: ReviewAction, withUndo = false) {
    const status = action.undo?.status ?? action.status
    const message = `${(action.undo ? 'Undo ' : '') + action.label} · ${statusLabel(status)}`
    const error = action.undo?.error ?? action.error
    this.#publish({ notice: error ? `${message}. ${error}` : message })
    if (withUndo || error) {
      toast(message, {
        id: `triage-review-${action.id}`,
        description: error ?? undefined,
        action: canUndo(action)
          ? { label: 'Undo', onClick: () => void this.undoAction(action) }
          : undefined,
      })
    }
  }

  async poll() {
    if (
      this.#polling ||
      this.#working ||
      !this.#history.some((entry) => entry.status === 'pending' || entry.undo?.status === 'pending')
    )
      return
    this.#polling = true
    try {
      const smart = await this.#ownerApi()
      const pending = this.#history.filter(
        (entry) => entry.status === 'pending' || entry.undo?.status === 'pending',
      )
      await Promise.allSettled(
        pending.map(async (action) => {
          const next = await poll(this.#api, smart, action)
          if (!next || !this.#history.includes(action)) return
          if (next.undo ? next.undo.status === action.undo?.status : next.status === action.status)
            return
          this.#acceptStatus(action, next)
        }),
      )
    } catch {
      // A queued action stays pending while the Engine is unreachable.
    } finally {
      this.#polling = false
    }
  }
}
