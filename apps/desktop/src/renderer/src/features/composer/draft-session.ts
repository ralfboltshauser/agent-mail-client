import type { ComposeAttachment, ComposeDraft, ComposeFields, ComposePatch } from '@amc/protocol'
import * as Y from 'yjs'
import type { AmcApi } from '../../../../shared/api'

const remote = Symbol('engine')
const saveDelay = 550
const pollInterval = 1500

function base64(bytes: Uint8Array) {
  let binary = ''
  for (let offset = 0; offset < bytes.length; offset += 8192) {
    binary += String.fromCharCode(...bytes.subarray(offset, offset + 8192))
  }
  return btoa(binary)
}

function headerFields(draft: ComposeDraft): ComposeFields {
  return {
    accountId: draft.accountId,
    to: draft.to,
    cc: draft.cc,
    bcc: draft.bcc,
    subject: draft.subject,
    attachmentIds: draft.attachments.map((part) => part.id),
  }
}

function sameList<T>(left: T[], right: T[], equal: (a: T, b: T) => boolean) {
  return (
    left === right ||
    (left.length === right.length && left.every((item, i) => equal(item, right[i])))
  )
}

function sameAddresses(left: ComposeFields['to'], right: ComposeFields['to']) {
  return sameList(left, right, (a, b) => a.address === b.address && a.name === b.name)
}

function sameAttachments(left: ComposeAttachment[], right: ComposeAttachment[]) {
  return sameList(
    left,
    right,
    (a, b) =>
      a.id === b.id &&
      a.filename === b.filename &&
      a.mimeType === b.mimeType &&
      a.size === b.size &&
      a.contentId === b.contentId,
  )
}

function sameHeaders(
  left: Omit<ComposeFields, 'attachmentIds'>,
  right: Omit<ComposeFields, 'attachmentIds'>,
) {
  return (
    left.accountId === right.accountId &&
    left.subject === right.subject &&
    sameAddresses(left.to, right.to) &&
    sameAddresses(left.cc, right.cc) &&
    sameAddresses(left.bcc, right.bcc)
  )
}

function sameMirror(left: ComposeDraft, right: ComposeDraft) {
  return (
    left.mirrorError === right.mirrorError &&
    left.mirrorConflict === right.mirrorConflict &&
    Boolean(left.originalDraftLeft) === Boolean(right.originalDraftLeft)
  )
}

function sameDraft(left: ComposeDraft, right: ComposeDraft) {
  // Mirror status can change without a content revision. Compare the payload
  // consumed by this session, including Yjs bytes and attachment metadata.
  return (
    left.revision === right.revision &&
    left.update === right.update &&
    left.signature === right.signature &&
    left.quote === right.quote &&
    sameMirror(left, right) &&
    sameHeaders(left, right) &&
    sameAttachments(left.attachments, right.attachments)
  )
}

function rebaseFields(current: ComposeFields, next: ComposeFields, before: ComposeFields) {
  return {
    ...next,
    accountId: current.accountId === before.accountId ? next.accountId : current.accountId,
    subject: current.subject === before.subject ? next.subject : current.subject,
    to:
      sameAddresses(current.to, before.to) && !sameAddresses(current.to, next.to)
        ? next.to
        : current.to,
    cc:
      sameAddresses(current.cc, before.cc) && !sameAddresses(current.cc, next.cc)
        ? next.cc
        : current.cc,
    bcc:
      sameAddresses(current.bcc, before.bcc) && !sameAddresses(current.bcc, next.bcc)
        ? next.bcc
        : current.bcc,
  }
}

type DraftApi = Pick<AmcApi, 'composeDraft' | 'stageComposeBody' | 'saveCompose'>

export class DraftSession {
  readonly doc = new Y.Doc()
  readonly id: string
  #baseline: ComposeDraft
  #reviewed: ComposeDraft
  #mirror: ComposeDraft
  #getApi: () => DraftApi
  #fields: ComposeFields
  #attachments: ComposeAttachment[]
  #listeners = new Set<() => void>()
  #version = 0
  #saved = 0
  #saveChain: Promise<unknown> = Promise.resolve()
  #timer: ReturnType<typeof setTimeout> | undefined
  #active = false
  #paused = false

  constructor(draft: ComposeDraft, getApi: () => DraftApi) {
    this.id = draft.id
    this.#getApi = getApi
    this.#baseline = this.#reviewed = this.#mirror = draft
    this.#fields = headerFields(draft)
    this.#attachments = draft.attachments
    this.apply(draft.update)
  }

  get fields() {
    return this.#fields
  }

  get attachments() {
    return this.#attachments
  }

  get reviewed() {
    return this.#reviewed
  }

  get mirror() {
    return this.#mirror
  }

  get dirty() {
    return this.#version !== this.#saved
  }

  subscribe = (listener: () => void) => {
    this.#listeners.add(listener)
    return () => {
      this.#listeners.delete(listener)
    }
  }

  #publish() {
    for (const listener of this.#listeners) listener()
  }

  updateField = <K extends Exclude<keyof ComposeFields, 'attachmentIds'>>(
    key: K,
    value: ComposeFields[K],
  ) => {
    if (Object.is(this.#fields[key], value)) return
    this.#fields = { ...this.#fields, [key]: value }
    this.#publish()
    this.changed()
  }

  updateAttachments(attachments: ComposeAttachment[]) {
    this.#attachments = attachments
    this.#publish()
    this.changed()
  }

  apply(update: string) {
    Y.applyUpdate(
      this.doc,
      Uint8Array.from(atob(update), (ch) => ch.charCodeAt(0)),
      remote,
    )
  }

  rebase(next: ComposeDraft, before = headerFields(this.#baseline)) {
    this.apply(next.update)
    this.#baseline = this.#reviewed = this.#mirror = next
    this.#fields = rebaseFields(this.#fields, headerFields(next), before)
    const currentIds = this.#attachments.map((part) => part.id)
    const attachments = [
      ...next.attachments.filter(
        (part) => !before.attachmentIds.includes(part.id) || currentIds.includes(part.id),
      ),
      ...this.#attachments.filter(
        (part) =>
          !before.attachmentIds.includes(part.id) &&
          !next.attachments.some(({ id }) => id === part.id),
      ),
    ]
    if (!sameAttachments(this.#attachments, attachments)) this.#attachments = attachments
    this.#publish()
  }

  patch(revision: number): ComposePatch {
    const fields = { ...this.#fields, attachmentIds: this.#attachments.map((part) => part.id) }
    const baseline = headerFields(this.#baseline)
    return {
      baseRevision: revision,
      update: base64(Y.encodeStateAsUpdate(this.doc)),
      fields:
        sameHeaders(fields, baseline) &&
        sameList(fields.attachmentIds, baseline.attachmentIds, Object.is)
          ? undefined
          : fields,
    }
  }

  save() {
    this.#clearTimer()
    return this.#queueSave()
  }

  #queueSave(autosaveVersion?: number) {
    const pending = this.whenSaved().then(async () => {
      if (
        autosaveVersion !== undefined &&
        (!this.#active || this.#paused || !this.dirty || this.#version !== autosaveVersion)
      ) {
        return this.#baseline
      }
      const started = this.#version
      const patch = this.patch(this.#baseline.revision)
      const submitted = patch.fields ?? headerFields(this.#baseline)
      const updated = await this.#getApi().saveCompose(this.id, patch)
      this.#saved = started
      this.rebase(updated, submitted)
      return updated
    })
    this.#saveChain = pending
    return pending
  }

  whenSaved() {
    return this.#saveChain.catch(() => {})
  }

  changed() {
    this.#version++
    this.#queueAutosave()
  }

  pauseAutosave(paused: boolean) {
    if (this.#paused === paused) return
    this.#paused = paused
    this.#queueAutosave()
  }

  #onSaveError: (cause: unknown) => void = () => {}

  #clearTimer() {
    clearTimeout(this.#timer)
    this.#timer = undefined
  }

  #queueAutosave() {
    this.#clearTimer()
    if (!this.#active || this.#paused || !this.dirty) return
    const version = this.#version
    this.#timer = setTimeout(() => {
      this.#timer = undefined
      void this.#queueSave(version).catch(this.#onSaveError)
    }, saveDelay)
  }

  connect({
    onStageError,
    onSaveError,
    skipPoll,
    uploadInFlight,
  }: {
    onStageError: (cause: unknown) => void
    onSaveError: (cause: unknown) => void
    skipPoll: () => boolean
    uploadInFlight: () => boolean
  }) {
    this.#active = true
    this.#onSaveError = onSaveError
    this.#queueAutosave()
    const onUpdate = (_bytes: Uint8Array, origin: unknown) => {
      if (origin === remote) return
      try {
        // Stage every local transaction synchronously for crash recovery.
        this.#getApi().stageComposeBody(this.id, {
          baseRevision: this.#baseline.revision,
          update: base64(Y.encodeStateAsUpdate(this.doc)),
        })
      } catch (cause) {
        onStageError(cause)
      }
      this.changed()
    }
    this.doc.on('update', onUpdate)
    let running = false
    let connected = true
    const poll = setInterval(() => {
      if (running || skipPoll() || this.dirty) return
      running = true
      const before = this.#baseline
      const version = this.#version
      void this.#getApi()
        .composeDraft(this.id)
        .then((next) => {
          if (
            !connected ||
            skipPoll() ||
            version !== this.#version ||
            before !== this.#baseline ||
            next.revision < before.revision
          )
            return
          const same = sameDraft(this.#reviewed, next)
          const mirrorChanged = !sameMirror(this.#mirror, next)
          if (same && !mirrorChanged) return
          if (!uploadInFlight()) this.rebase(next)
          else {
            if (next.update !== this.#reviewed.update) this.apply(next.update)
            if (mirrorChanged) {
              this.#mirror = next
              this.#publish()
            }
          }
        })
        .catch(() => {})
        .finally(() => {
          running = false
        })
    }, pollInterval)
    return () => {
      connected = false
      this.#active = false
      this.#clearTimer()
      clearInterval(poll)
      this.doc.off('update', onUpdate)
    }
  }
}
