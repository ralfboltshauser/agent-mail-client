import { COMPOSER_FIELD, INLINE_IMAGE_NAME } from '@amc/composer'
import type { ComposeAttachment, ComposeDraft, ComposeFields, ComposePatch } from '@amc/protocol'
import * as Y from 'yjs'
import { recordCaughtFailure } from '@/lib/failure'
import type { AmcApi } from '../../../../shared/api'

import { DRAFT_POLL_INTERVAL, isMissingDraft } from './draft-availability'

const remote = Symbol('engine')
const saveDelay = 550

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

function sameFields(left: ComposeFields, right: ComposeFields) {
  return sameHeaders(left, right) && sameList(left.attachmentIds, right.attachmentIds, Object.is)
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
  #savingFields: ComposeFields | undefined
  #saveChain: Promise<unknown> = Promise.resolve()
  #timer: ReturnType<typeof setTimeout> | undefined
  #active = false
  #paused = false
  #discarded = false

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
    this.#localEdit()
    this.#publish()
  }

  updateAttachments(attachments: ComposeAttachment[]) {
    this.#attachments = attachments
    this.#localEdit()
    this.#publish()
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
    if (this.dirty) this.#stage()
    this.#publish()
  }

  patch(revision: number): ComposePatch {
    const fields = { ...this.#fields, attachmentIds: this.#attachments.map((part) => part.id) }
    const baseline = headerFields(this.#baseline)
    return {
      baseRevision: revision,
      update: base64(Y.encodeStateAsUpdate(this.doc)),
      fields:
        sameFields(fields, baseline) &&
        (!this.#savingFields || sameFields(fields, this.#savingFields))
          ? undefined
          : fields,
    }
  }

  recoveryPatch(draft: ComposeDraft): ComposePatch {
    const replacement = new DraftSession(draft, this.#getApi)
    try {
      const body = replacement.doc.getXmlFragment(COMPOSER_FIELD)
      const source = this.doc.getXmlFragment(COMPOSER_FIELD)
      body.delete(0, body.length)
      body.insert(
        0,
        source
          .toArray()
          .flatMap((node) =>
            node instanceof Y.XmlElement || node instanceof Y.XmlText ? [node.clone()] : [],
          ),
      )
      // Attachment IDs belong to the deleted draft. Keep inline image labels as text.
      for (const node of Array.from(
        body.createTreeWalker(
          (node) => node instanceof Y.XmlElement && node.nodeName === INLINE_IMAGE_NAME,
        ),
      )) {
        if (!(node instanceof Y.XmlElement) || !node.parent) continue
        const parent = node.parent as Y.XmlElement
        const index = parent.toArray().indexOf(node)
        const label = new Y.XmlText()
        label.insert(0, `[Image: ${node.getAttribute('alt') || 'attachment'}]`)
        parent.delete(index, 1)
        parent.insert(index, [label])
      }
      return {
        ...replacement.patch(draft.revision),
        fields: { ...this.#fields, attachmentIds: [] },
      }
    } finally {
      replacement.doc.destroy()
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
        (!this.#active ||
          this.#paused ||
          this.#discarded ||
          !this.dirty ||
          this.#version !== autosaveVersion)
      ) {
        return this.#baseline
      }
      const started = this.#version
      const patch = this.patch(this.#baseline.revision)
      const submitted = patch.fields ?? headerFields(this.#baseline)
      this.#savingFields = patch.fields
      const updated = await this.#getApi()
        .saveCompose(this.id, patch)
        .finally(() => {
          this.#savingFields = undefined
        })
      if (this.#discarded) return updated
      this.#saved = started
      this.rebase(updated, submitted)
      return updated
    })
    this.#saveChain = pending
    return pending
  }

  whenSaved() {
    return this.#saveChain.catch(recordCaughtFailure)
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

  #localEdit() {
    this.#stage()
    this.changed()
  }

  #stage() {
    if (!this.#active || this.#discarded) return
    try {
      // Stage each local edit synchronously for native close and crash recovery.
      this.#getApi().stageComposeBody(this.id, this.patch(this.#baseline.revision))
    } catch (cause) {
      this.#onStageError(cause)
    }
  }

  #onStageError: (cause: unknown) => void = () => {}
  #onSaveError: (cause: unknown) => void = () => {}

  #clearTimer() {
    clearTimeout(this.#timer)
    this.#timer = undefined
  }

  #queueAutosave() {
    this.#clearTimer()
    if (!this.#active || this.#paused || this.#discarded || !this.dirty) return
    const version = this.#version
    this.#timer = setTimeout(() => {
      this.#timer = undefined
      void this.#queueSave(version).catch((cause) => {
        if (!this.#discarded) this.#onSaveError(cause)
      })
    }, saveDelay)
  }

  connect({
    onStageError,
    onSaveError,
    onDiscarded,
    skipPoll,
    uploadInFlight,
  }: {
    onStageError: (cause: unknown) => void
    onSaveError: (cause: unknown) => void
    onDiscarded: () => void
    skipPoll: () => boolean
    uploadInFlight: () => boolean
  }) {
    this.#active = true
    this.#onStageError = onStageError
    this.#onSaveError = onSaveError
    this.#queueAutosave()
    const onUpdate = (_bytes: Uint8Array, origin: unknown) => {
      if (origin !== remote) this.#localEdit()
    }
    this.doc.on('update', onUpdate)
    let running = false
    let connected = true
    const poll = setInterval(() => {
      if (running || this.#discarded || skipPoll()) return
      running = true
      const before = this.#baseline
      const version = this.#version
      void this.#getApi()
        .composeDraft(this.id)
        .then((next) => {
          if (
            !connected ||
            skipPoll() ||
            this.dirty ||
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
        .catch((cause) => {
          recordCaughtFailure(cause)
          if (!connected || skipPoll() || uploadInFlight() || !isMissingDraft(cause)) return
          this.#discarded = true
          clearInterval(poll)
          this.#clearTimer()
          onDiscarded()
        })
        .finally(() => {
          running = false
        })
    }, DRAFT_POLL_INTERVAL)
    return () => {
      connected = false
      this.#active = false
      this.#clearTimer()
      clearInterval(poll)
      this.doc.off('update', onUpdate)
    }
  }
}
