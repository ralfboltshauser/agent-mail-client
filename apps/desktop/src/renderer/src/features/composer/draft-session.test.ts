import type { ComposeDraft, ComposePatch } from '@amc/protocol'
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import * as Y from 'yjs'
import { DraftSession } from './draft-session'

const draft: ComposeDraft = {
  id: 'draft',
  accountId: 'account',
  threadId: null,
  from: 'owner@example.test',
  to: [{ address: 'recipient@example.test', name: null }],
  cc: [],
  bcc: [],
  subject: 'Original subject',
  body: '',
  lastAuthor: 'owner',
  updatedAt: 0,
  revision: 1,
  update: 'AAA=',
  attachments: [],
  quote: '',
  signature: '',
  mirrorError: false,
  mirrorConflict: false,
}

const deferred = <T>() => {
  let resolve!: (value: T) => void
  const promise = new Promise<T>((done) => {
    resolve = done
  })
  return { promise, resolve }
}

function setup() {
  const api = {
    stageComposeBody: vi.fn(),
    composeDraft: vi.fn(async () => structuredClone(draft)),
    saveCompose: vi.fn(async (_id: string, patch: ComposePatch) => ({
      ...draft,
      ...patch.fields,
      revision: patch.baseRevision + 1,
      update: patch.update,
    })),
  }
  const session = new DraftSession(draft, () => api)
  const disconnect = session.connect({
    onStageError: vi.fn(),
    onSaveError: vi.fn(),
    skipPoll: () => false,
    uploadInFlight: () => false,
  })
  return { session, api, disconnect }
}

function decodeBody(update: string) {
  const doc = new Y.Doc()
  Y.applyUpdate(doc, Buffer.from(update, 'base64'))
  const text = doc.getText('body').toString()
  doc.destroy()
  return text
}

describe('draft session', () => {
  beforeEach(() => vi.useFakeTimers())
  afterEach(() => vi.useRealTimers())

  it('stages every body edit immediately and saves one snapshot after the last edit', async () => {
    const { session, api, disconnect } = setup()
    const body = session.doc.getText('body')
    const changed = vi.fn()
    session.subscribe(changed)

    body.insert(0, 'a')
    expect(decodeBody(api.stageComposeBody.mock.calls[0][1].update)).toBe('a')
    expect(changed).toHaveBeenCalledTimes(0)
    await vi.advanceTimersByTimeAsync(400)
    session.updateField('subject', 'New subject')
    body.insert(1, 'b')
    expect(api.stageComposeBody).toHaveBeenCalledTimes(3)
    const staged = api.stageComposeBody.mock.calls[2][1]
    expect(decodeBody(staged.update)).toBe('ab')
    expect(staged.fields.subject).toBe('New subject')
    await vi.advanceTimersByTimeAsync(549)
    expect(api.saveCompose).toHaveBeenCalledTimes(0)
    await vi.advanceTimersByTimeAsync(1)
    expect(api.saveCompose).toHaveBeenCalledTimes(1)
    expect(api.saveCompose).toHaveBeenCalledWith('draft', {
      baseRevision: 1,
      update: staged.update,
      fields: {
        accountId: 'account',
        subject: 'New subject',
        to: draft.to,
        cc: [],
        bcc: [],
        attachmentIds: [],
      },
    })
    expect(session.reviewed.revision).toBe(2)
    disconnect()
  })

  it('accepts equal-revision changes to Yjs, headers, attachments, and mirror status', async () => {
    const { session, api, disconnect } = setup()
    const published = vi.fn()
    session.subscribe(published)
    const to = session.fields.to
    await vi.advanceTimersByTimeAsync(1500)
    expect(api.composeDraft).toHaveBeenCalledOnce()
    expect(published).toHaveBeenCalledTimes(0)

    const remote = new Y.Doc()
    remote.getText('body').insert(0, 'Remote body')
    const update = Buffer.from(Y.encodeStateAsUpdate(remote)).toString('base64')
    const next = {
      ...draft,
      mirrorError: true,
      mirrorConflict: true,
      originalDraftLeft: true,
      updatedAt: 2,
      subject: 'Remote subject',
      quote: 'Quoted text',
      signature: 'New signature',
      attachments: [
        { id: 'part', filename: 'note.txt', mimeType: 'text/plain', size: 3, contentId: null },
      ],
      update,
    }
    api.composeDraft.mockImplementation(async () => structuredClone(next))
    await vi.advanceTimersByTimeAsync(1500)
    expect(published).toHaveBeenCalledOnce()
    expect(session.reviewed).toEqual(next)
    expect(session.mirror).toMatchObject({
      mirrorError: true,
      mirrorConflict: true,
      originalDraftLeft: true,
    })
    expect(session.fields.subject).toBe('Remote subject')
    expect(session.fields.to).toBe(to)
    expect(session.attachments).toEqual(next.attachments)
    expect(session.doc.getText('body').toString()).toBe('Remote body')
    expect(api.stageComposeBody).toHaveBeenCalledTimes(0)
    await vi.advanceTimersByTimeAsync(1500)
    expect(published).toHaveBeenCalledOnce()
    expect(api.saveCompose).toHaveBeenCalledTimes(0)
    disconnect()
    remote.destroy()
  })

  it('applies a mirror-only change at the same revision', async () => {
    const { session, api, disconnect } = setup()
    api.composeDraft.mockResolvedValueOnce({ ...draft, mirrorError: true })
    await vi.advanceTimersByTimeAsync(1500)
    expect(session.mirror.mirrorError).toBe(true)
    expect(session.reviewed.revision).toBe(1)
    disconnect()
  })

  it('ignores an old poll after a local edit and its save', async () => {
    const { session, api, disconnect } = setup()
    const poll = deferred<ComposeDraft>()
    api.composeDraft.mockReturnValueOnce(poll.promise)
    await vi.advanceTimersByTimeAsync(1500)
    session.updateField('subject', 'Local subject')
    await vi.advanceTimersByTimeAsync(550)
    poll.resolve({ ...draft, revision: 2, subject: 'Old poll' })
    await vi.advanceTimersByTimeAsync(0)
    expect(session.fields.subject).toBe('Local subject')
    disconnect()
  })

  it('serializes saves and preserves edits made while an earlier save is pending', async () => {
    const { session, api, disconnect } = setup()
    const first = deferred<ComposeDraft>()
    api.saveCompose.mockReturnValueOnce(first.promise)
    session.updateField('subject', 'First change')
    await vi.advanceTimersByTimeAsync(550)
    session.updateField('subject', 'Second change')
    await vi.advanceTimersByTimeAsync(550)
    expect(api.saveCompose).toHaveBeenCalledOnce()
    expect(session.reviewed.revision).toBe(1)

    // This resets the debounce even though the previous timer already fired.
    session.updateField('subject', 'Final change')
    first.resolve({ ...draft, revision: 2, subject: 'First change' })
    await vi.advanceTimersByTimeAsync(549)
    expect(api.saveCompose).toHaveBeenCalledOnce()
    expect(session.fields.subject).toBe('Final change')
    await vi.advanceTimersByTimeAsync(1)
    expect(api.saveCompose).toHaveBeenCalledTimes(2)
    expect(api.saveCompose).toHaveBeenLastCalledWith(
      'draft',
      expect.objectContaining({
        baseRevision: 2,
        fields: expect.objectContaining({ subject: 'Final change' }),
      }),
    )
    expect(session.reviewed.revision).toBe(3)
    expect(session.dirty).toBe(false)
    disconnect()
  })

  it('stages a subject reverted while an older autosave is in flight', async () => {
    const { session, api, disconnect } = setup()
    const first = deferred<ComposeDraft>()
    api.saveCompose.mockReturnValueOnce(first.promise)
    session.updateField('subject', 'Changed subject')
    await vi.advanceTimersByTimeAsync(550)
    session.updateField('subject', draft.subject)
    expect(api.stageComposeBody).toHaveBeenLastCalledWith(
      draft.id,
      expect.objectContaining({
        baseRevision: 1,
        fields: expect.objectContaining({ subject: draft.subject }),
      }),
    )

    first.resolve({ ...draft, revision: 2, subject: 'Changed subject' })
    await session.whenSaved()
    expect(api.stageComposeBody).toHaveBeenLastCalledWith(
      draft.id,
      expect.objectContaining({
        baseRevision: 2,
        fields: expect.objectContaining({ subject: draft.subject }),
      }),
    )
    disconnect()
  })

  it('pauses a pending autosave for review and flushes edits on explicit save', async () => {
    const { session, api, disconnect } = setup()
    session.updateField('subject', 'Minimised subject')
    session.pauseAutosave(true)
    await vi.advanceTimersByTimeAsync(600)
    expect(api.saveCompose).toHaveBeenCalledTimes(0)
    expect(session.reviewed.revision).toBe(1)
    const persisted = await session.save()
    expect(persisted.subject).toBe('Minimised subject')
    expect(session.reviewed.revision).toBe(2)
    disconnect()
    await vi.advanceTimersByTimeAsync(2000)
    expect(api.composeDraft).toHaveBeenCalledTimes(0)
  })
})
