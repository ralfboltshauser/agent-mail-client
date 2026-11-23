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
  cardKey,
  type Decision,
  type Preview,
  type ReviewAction,
  reviewError,
  type Session,
  sameTarget,
} from './model'
import { loadPreview } from './preview'
import { loadQueue, partitionQueue } from './queue'

export class ReviewStore {
  #saved: SavedReview | null = null
  #account = ''
  #active = false
  #read = 0
  #replicaVersion = 0
  #working = false
  #queueVersion = -1
  #syncing: number | null = null
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
    skipped: 0,
    pending: 0,
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
    this.#queueVersion = -1
    this.#account = JSON.stringify(accountId)
    this.#active = true
    this.#publish({
      card: null,
      error: null,
      progress: '',
      busy: true,
      finished: false,
      skipped: 0,
      pending: 0,
      notice: '',
    })
    void this.refresh()
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
    void this.#syncQueue()
  }

  async #syncQueue() {
    if (
      !this.#active ||
      this.#syncing === this.#read ||
      this.#view.busy ||
      this.#view.error ||
      this.#queueVersion === this.#replicaVersion
    )
      return
    const generation = this.#read
    this.#syncing = generation
    const version = this.#replicaVersion
    try {
      if (this.#view.finished) await this.refresh()
      else await this.#checkQueue(generation, 'append')
    } catch {
      // Keep the current card usable. A later change or the end of the review retries.
    } finally {
      if (this.#syncing === generation) this.#syncing = null
      if (generation !== this.#read || version !== this.#replicaVersion) void this.#syncQueue()
    }
  }

  async refresh(target: 'current' | 'skipped' = 'current') {
    const generation = ++this.#read
    this.#next = null
    this.#publish({ busy: true, error: null })
    try {
      await this.restore()
      if (generation !== this.#read) return
      const session = this.#session
      if (target === 'skipped' || !session || session.index >= session.ids.length)
        await this.#checkQueue(generation, target === 'skipped' ? 'revisit' : 'finish')
      else {
        await this.#ownerApi()
        if (generation === this.#read) await this.#display(generation)
      }
    } catch (error) {
      if (generation === this.#read) this.#publish({ busy: false, error: reviewError(error) })
    } finally {
      void this.#syncQueue()
    }
  }

  #skips() {
    const batches = new Set(
      Object.entries(this.#saved?.parked ?? {})
        .filter(([, entry]) => entry.accountKey === this.#account)
        .map(([batch]) => batch),
    )
    if (this.#session) batches.add(this.#session.batch)
    return this.#history.filter(
      (entry) =>
        batches.has(entry.batch) &&
        entry.status === 'applied' &&
        entry.decision.kind === 'skip' &&
        !entry.decision.revisited,
    )
  }

  async #checkQueue(generation: number, mode: 'append' | 'finish' | 'revisit', exhausted = false) {
    const smart = await this.#ownerApi()
    const session = this.#session
    const accountId = JSON.parse(this.#account) as string | null
    while (generation === this.#read && this.#active) {
      const version = this.#replicaVersion
      const cards = await loadQueue(smart, accountId ?? undefined)
      if (generation !== this.#read || !this.#saved) return
      if (version !== this.#replicaVersion) continue
      this.#queueVersion = version

      const skips = this.#skips()
      const { ready, skipped, pending } = partitionQueue(cards, skips, this.#history)
      if (mode === 'append') {
        if (!session) return
        const queued = new Set(session.ids.slice(session.index).map(cardKey))
        const additions = ready.filter((id) => !queued.has(cardKey(id)))
        if (additions.length) {
          const wasLast = session.index === session.ids.length - 1
          session.ids.push(...additions)
          this.#save()
          this.#publish({ progress: `${session.index + 1}/${session.ids.length}` })
          if (wasLast) this.#preload(session.batch, session.index + 1)
        }
        return
      }
      const revisiting = mode === 'revisit' && skipped.length > 0
      const ids = revisiting ? [...skipped, ...ready] : ready
      if (ids.length) {
        if (exhausted)
          throw new Error('The triage queue changed while loading cards. Retry to refresh.')
        if (revisiting) {
          const revisited = new Set(skipped.map(cardKey))
          const actionIds = new Set(
            skips.filter(({ card }) => revisited.has(cardKey(card))).map(({ id }) => id),
          )
          this.#saved.history = this.#history.map((entry) =>
            actionIds.has(entry.id)
              ? { ...entry, decision: { kind: 'skip', revisited: true } }
              : entry,
          )
          this.#publish({ history: this.#history })
        }
        const visited = new Set(session?.ids.map(cardKey))
        if (!session || revisiting || ids.some((id) => visited.has(cardKey(id)))) {
          this.#switchBatch(this.#account, { batch: crypto.randomUUID(), ids, index: 0 })
        } else {
          session.ids.push(...ids)
        }
        await this.#display(generation, undefined, true)
        return
      }
      const total = session?.ids.length ?? 0
      this.#publish({
        card: null,
        progress: `${total}/${total}`,
        finished: true,
        skipped: skipped.length,
        pending,
        busy: false,
        error: null,
      })
      return
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

  async #display(generation: number, cached?: Preview, checkedQueue = false) {
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
            (entry.decision.kind === 'skip'
              ? !entry.decision.revisited
              : entry.card.kind === 'thread' || entry.decision.kind === 'sender'),
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
          skipped: 0,
          pending: 0,
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
    if (!this.#view.busy) this.#publish({ busy: true })
    await this.#checkQueue(generation, 'finish', checkedQueue)
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
    } finally {
      void this.#syncQueue()
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
    const unconfirmed = this.#history.find(
      (entry) =>
        entry.batch === action.batch &&
        entry.index === action.index &&
        entry.threadId === action.threadId &&
        entry.status === 'unconfirmed',
    )
    if (unconfirmed && unconfirmed.id !== id) {
      this.#publish({
        notice: 'Retry the unconfirmed decision from action history before making another.',
      })
      return
    }
    const generation = this.#read
    this.#working = true
    this.#publish({ busy: true })
    try {
      if (!unconfirmed) await this.validate(card)
      if (generation !== this.#read || this.#view.card !== card) return
      return await this.#submit(action)
    } catch (error) {
      if (generation === this.#read) this.#publish({ error: reviewError(error) })
    } finally {
      this.#working = false
      if (generation === this.#read) this.#publish({ busy: false })
      void this.#syncQueue()
    }
  }

  async #submit(action: ReviewAction) {
    const decision = action.decision
    let publicAction = action
    if (decision.kind === 'filter' || decision.kind === 'sender') {
      const { reason, ...input } = decision.input
      publicAction = {
        ...action,
        decision: { ...decision, input } as Decision,
        privateReasonDraft: reason ? true : undefined,
      }
    }
    try {
      this.#update(publicAction, { status: 'unconfirmed', error: null }, true)
      const smart = await this.#ownerApi()
      const result = await submit(smart, action)
      const updated = this.#update(publicAction, {
        privateReasonDraft: undefined,
        status: result.status,
        error: result.error,
      })
      this.#announce(updated, true)
      if (result.status === 'applied' || result.status === 'pending') {
        await this.#advance(
          updated,
          action.card.kind === 'sender' && action.decision.kind !== 'sender',
        )
      }
      return true
    } catch (error) {
      const message = reviewError(error)
      const rejected = message.startsWith('Review rejected: ')
      this.#announce(
        this.#update(publicAction, {
          privateReasonDraft: rejected ? undefined : publicAction.privateReasonDraft,
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
      if (action.privateReasonDraft) {
        const smart = await this.#ownerApi()
        const receipt = await smart.ownerAction(action.id)
        const accepted = this.#update(action, {
          privateReasonDraft: undefined,
          status: receipt.status,
          error: receipt.error,
        })
        this.#announce(accepted)
        if (receipt.status === 'pending' || receipt.status === 'applied')
          await this.#advance(
            accepted,
            action.card.kind === 'sender' && action.decision.kind !== 'sender',
          )
        return
      }
      await this.#submit(action)
    } catch (error) {
      if (action.privateReasonDraft && reviewError(error).includes('Owner action unavailable')) {
        this.#announce(
          this.#update(action, {
            privateReasonDraft: undefined,
            status: 'rejected',
            error:
              'The Engine did not accept this decision. Review the card to enter a new reason.',
          }),
        )
        return
      }
      this.#announce(this.#update(action, { error: reviewError(error) }))
    } finally {
      this.#working = false
    }
  }

  async loadReason(action: ReviewAction) {
    const smart = await this.#ownerApi()
    const result = await smart.ownerAction(action.id, true)
    return { reason: result.ownerReason ?? '', revision: result.reasonRevision ?? null }
  }

  async editReason(action: ReviewAction, reason: string, expectedReasonRevision: string | null) {
    const smart = await this.#ownerApi()
    if (!smart.editOwnerReason) throw new Error('Reason editing is unavailable')
    await smart.editOwnerReason(action.id, {
      editId: crypto.randomUUID(),
      expectedReasonRevision,
      reason: reason || null,
    })
  }

  async adoptDestination(action: ReviewAction, providerId: string) {
    if (this.#working) return
    this.#working = true
    try {
      const smart = await this.#ownerApi()
      await smart.adoptScreenedDestination({
        accountId: action.accountId,
        providerId,
        ...(action.decision.kind === 'filter' ? { destination: 'filtered' } : {}),
      })
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
            'This card belongs to an earlier batch. Reopen triage to review its current state.',
        })
      return
    }
    session.index = action.index
    const parked = this.#saved?.parked?.[action.batch]
    if (parked) this.#switchBatch(parked.accountKey, session)
    else this.#save()
    if (this.#active && session === this.#session) void this.refresh()
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
    if (action.status === 'pending' && updated.status !== 'pending' && this.#view.finished) {
      this.#replicaVersion++
      void this.#syncQueue()
    }
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
