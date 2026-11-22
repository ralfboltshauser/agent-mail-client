import { toast } from 'sonner'
import { getAmc } from '@/lib/amc'
import type { ReviewApi, SmartInboxApi } from '../../../../shared/api'
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
import {
  type Decision,
  type Preview,
  type ReviewAction,
  reviewError,
  type Session,
  sameTarget,
} from './model'
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
  #smart: (SmartInboxApi & ReviewApi) | undefined = this.#api.smartInbox?.review
    ? { ...this.#api.smartInbox, ...this.#api.smartInbox.review }
    : undefined
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
  get busy() {
    return this.#working || this.#view.busy
  }

  get #session() {
    return this.#saved?.sessions[this.#account]
  }
  get #history() {
    return this.#saved?.history ?? []
  }

  #save() {
    if (!this.#saved) return false
    try {
      saveReview(this.#saved)
      if (this.#view.storageError) this.#publish({ storageError: false })
      return true
    } catch {
      this.#publish({ storageError: true })
      return false
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
      busy: true,
      finished: false,
      more: false,
      notice: '',
    })
    void this.refresh(false)
  }

  close() {
    this.#active = false
    this.#read++
    this.#next = null
  }

  replicaChanged() {
    this.#replicaVersion++
    this.#next = null
    void this.poll(true)
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
      const previous = this.#session
      if (!previous || newBatch) {
        const next = previous?.nextBatch && this.#saved?.parked?.[previous.nextBatch]
        if (next && next.accountKey === this.#account) {
          this.#switchBatch(next.accountKey, next.session)
        } else {
          const accountId = JSON.parse(this.#account) as string | null
          const cursor = previous?.cursor
          const page = await smart.triageQueue({
            accountId: accountId ?? undefined,
            limit: 100,
            ...(cursor ? { cursor, nextBatch: '1' } : {}),
          })
          if (generation !== this.#read || !this.#saved) return
          if (!page.reviewLookup) throw new Error('Update the Engine to use desktop triage review.')
          const batch = crypto.randomUUID()
          if (previous) previous.nextBatch = batch
          this.#switchBatch(this.#account, {
            batch,
            ids: page.cards.map(({ id }) => id),
            index: 0,
            cursor: page.cursor,
          })
        }
        this.#retryBatch = false
      }
      await this.#display(generation)
    } catch (error) {
      if (generation === this.#read) this.#publish({ busy: false, error: reviewError(error) })
    }
  }

  #switchBatch(accountKey: string, session: Session) {
    if (!this.#saved) return
    this.#saved.parked ??= {}
    const parked = this.#saved.parked
    const previous = this.#saved.sessions[accountKey]
    if (previous && previous !== session) parked[previous.batch] = { accountKey, session: previous }
    this.#saved.sessions[accountKey] = session
    delete parked[session.batch]
    this.#save()
  }

  async #display(generation: number, cached?: Preview) {
    const session = this.#session
    if (!session || !this.#smart || !this.#active) return
    let notice = this.#view.notice
    for (let index = session.index; index < session.ids.length; index++) {
      if (
        this.#history.some(
          (entry) =>
            entry.batch === session.batch &&
            entry.index === index &&
            (entry.status === 'pending' || entry.status === 'applied') &&
            (entry.decision.kind === 'skip' ||
              entry.card.kind === 'thread' ||
              entry.decision.kind === 'sender'),
        )
      )
        continue
      let preview: Preview | null | undefined = index === session.index ? cached : undefined
      if (!preview) {
        if (!this.#view.busy) this.#publish({ busy: true })
        preview = await loadPreview(
          this.#api,
          this.#smart,
          session.ids[index],
          this.#history,
          session.batch,
        )
      }
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
      more: !!(session.cursor || session.nextBatch),
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

  #update(action: ReviewAction, patch: Partial<ReviewAction>, requireStorage = false) {
    const updated = { ...action, ...patch }
    const saved = this.#saved
    if (!saved) return updated
    saved.history = saved.history.some(({ id }) => id === action.id)
      ? saved.history.map((entry) => (entry.id === action.id ? updated : entry))
      : [...saved.history, updated]
    const savedLocally = this.#save()
    this.#publish({ history: saved.history })
    if (requireStorage && !savedLocally)
      throw new Error('Could not save this decision locally. Retry from action history.')
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
    try {
      await this.#display(generation, cached)
    } catch (error) {
      if (generation === this.#read) this.#publish({ busy: false, error: reviewError(error) })
    }
  }

  #position(card: Preview) {
    const session = this.#session
    if (!session || !this.#active || this.#view.card !== card) return null
    return {
      batch: session.batch,
      index: session.index,
      card: card.id,
      accountId: card.accountId,
      threadId: card.threadId,
      messageId: card.messageId,
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
    const position = this.#position(card)
    if (!position || this.busy || this.#view.error) return
    const action: ReviewAction = {
      ...position,
      id,
      decision,
      label,
      status: 'unconfirmed',
      error: null,
    }
    if (decision.kind === 'skip') {
      this.#update(action, { status: 'applied' })
      void this.#advance(action, false)
      return
    }
    if (
      this.#history.some(
        (entry) =>
          entry.batch === action.batch &&
          entry.index === action.index &&
          entry.threadId === action.threadId &&
          entry.status === 'unconfirmed',
      )
    ) {
      this.#publish({
        notice: 'Retry the unconfirmed decision from action history before making another.',
      })
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
    try {
      this.#update(action, { status: 'unconfirmed', error: null }, true)
      const smart = await this.#ownerApi()
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
      const message = reviewError(error)
      const rejected = message.startsWith('Review rejected: ')
      this.#announce(
        this.#update(action, {
          status: rejected ? 'rejected' : 'unconfirmed',
          error: message.replace(/^Review rejected: /, ''),
        }),
      )
    }
  }

  async retryAction(action: ReviewAction) {
    const latest = this.#history.find(({ id }) => id === action.id)
    if (this.#working || !latest) return
    action = latest
    if (action.status !== 'unconfirmed') {
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

  async adoptDestination(action: ReviewAction, providerId: string) {
    if (this.#working) return
    this.#working = true
    try {
      const smart = await this.#ownerApi()
      await smart.adoptScreenedDestination({ accountId: action.accountId, providerId })
      this.#announce(this.#update(action, { status: 'pending', error: null }))
    } catch (error) {
      this.#publish({ notice: reviewError(error) })
    } finally {
      this.#working = false
    }
  }

  #returnTo(action: ReviewAction) {
    const session = this.#sessionFor(action)
    if (!session) {
      if (this.#active)
        this.#publish({
          notice:
            'This card belongs to an earlier batch. Check for new cards to review its current state.',
        })
      return
    }
    session.index = action.index
    const parked = this.#saved?.parked?.[action.batch]
    if (parked) this.#switchBatch(parked.accountKey, session)
    else this.#save()
    if (this.#active && session === this.#session) void this.refresh(false)
  }

  #sessionFor(action: ReviewAction) {
    return (
      this.#saved?.parked?.[action.batch]?.session ??
      Object.values(this.#saved?.sessions ?? {}).find((session) => session.batch === action.batch)
    )
  }

  prepareReply(card: Preview) {
    const position = this.#position(card)
    if (!position) throw new Error('This card changed. Refresh it before replying.')
    return (id: string, decision: Extract<Decision, { kind: 'reply' }>, queued: boolean) => {
      const action = this.#update(
        {
          ...position,
          id,
          label: 'Reply',
          decision,
          status: queued ? 'pending' : 'applied',
          error: null,
        },
        {},
      )
      void this.#advance(action, card.id.kind === 'sender')
    }
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
      this.#update(action, { undo: { id, status: 'unconfirmed', error: null } }, true)
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

  async poll(recheckBlocks = false) {
    if (this.#polling || this.#working) return
    const pending = this.#history.filter(watchAction)
    const activeBlocks = recheckBlocks
      ? this.#history
          .filter(
            (entry) =>
              entry.status === 'applied' &&
              !entry.undo &&
              entry.decision.kind === 'sender' &&
              entry.decision.input.decision === 'block',
          )
          .slice(-8)
      : []
    if (!pending.length && !activeBlocks.length) return
    this.#polling = true
    try {
      const smart = await this.#ownerApi()
      await Promise.allSettled(
        [...pending, ...activeBlocks].map(async (action) => {
          const next = await poll(this.#api, smart, action)
          if (!next || !this.#history.includes(action)) return
          if (
            next.undo
              ? next.undo.status === action.undo?.status && next.undo.error === action.undo.error
              : next.status === action.status && next.error === action.error
          )
            return
          this.#acceptStatus(action, next)
          if (
            action.status === 'unconfirmed' &&
            !next.undo &&
            (next.status === 'applied' || next.status === 'pending')
          ) {
            await this.#advance(
              { ...action, ...next },
              action.card.kind === 'sender' && action.decision.kind !== 'sender',
            )
          }
        }),
      )
    } catch {
      // A queued action stays pending while the Engine is unreachable.
    } finally {
      this.#polling = false
    }
  }
}

function watchAction(action: ReviewAction) {
  return (
    action.status === 'pending' ||
    action.status === 'unconfirmed' ||
    action.undo?.status === 'pending' ||
    action.undo?.status === 'unconfirmed'
  )
}
