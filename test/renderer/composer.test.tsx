import { DatabaseSync } from 'node:sqlite'
import { act, cleanup, fireEvent, screen, within } from '@testing-library/react'
import { expect, it, vi } from 'vitest'
import { LocalDraftUpdates } from '../../apps/desktop/src/main/draft-updates'
import {
  type ComposePatch,
  DRAFT_CHANGED,
  type SendRequest,
} from '../../packages/protocol/src/index'

import { deferred } from './adapter'
import { commits, expectBudget } from './profile'
import { mount } from './workspace'

async function openComposer() {
  const adapter = await mount()
  await act(async () => fireEvent.click(screen.getByRole('button', { name: /^Compose/ })))
  const dialog = within(screen.getByRole('dialog', { name: 'Compose' }))
  const subject = dialog.getByRole<HTMLInputElement>('textbox', { name: 'Subject' })
  const editor = dialog.getByRole('textbox', { name: 'Message body' })
  const recipient = dialog.getByRole('combobox', { name: 'To' })
  for (const region of ['Composer', 'RecipientField', 'footer', 'SubjectField']) {
    expect(commits.get(region)).toBeGreaterThan(0)
  }
  commits.clear()
  return { adapter, dialog, subject, editor, recipient }
}

it('applies one subject character without replacing the composer fields', async () => {
  const { adapter, dialog, subject, editor, recipient } = await openComposer()
  await act(async () => {
    subject.focus()
    fireEvent.change(subject, { target: { value: `${subject.value}x` } })
  })
  expect(subject.value).toBe('x')
  expect(document.activeElement).toBe(subject)
  expect(dialog.getByRole('textbox', { name: 'Message body' })).toBe(editor)
  expect(dialog.getByRole('combobox', { name: 'To' })).toBe(recipient)
  expect(adapter.api.saveCompose).not.toHaveBeenCalled()
  expect(adapter.api.stageComposeBody).toHaveBeenCalledExactlyOnceWith(
    'draft-1',
    expect.objectContaining({ fields: expect.objectContaining({ subject: 'x' }) }),
  )
  expect(commits.get('SubjectField')).toBe(1)
  expectBudget(keystrokeBudget)
})

it('stages one body character without replacing the editor', async () => {
  const { adapter, dialog, editor, recipient } = await openComposer()
  const paragraph = editor.querySelector('p')
  if (!paragraph) throw new Error('The editor needs a paragraph for text insertion')
  await act(async () => {
    editor.focus()
    // jsdom has no native editing. Insert text as the browser would, then let
    // ProseMirror's mutation observer consume the real contenteditable change.
    const text = document.createTextNode('x')
    paragraph.replaceChildren(text)
    document.getSelection()?.collapse(text, 1)
    fireEvent.input(editor, { data: 'x', inputType: 'insertText' })
  })
  expect(adapter.api.stageComposeBody).toHaveBeenCalledTimes(1)
  expect(adapter.api.stageComposeBody.mock.calls[0]?.[0]).toBe('draft-1')
  expect(editor.textContent).toBe('x')
  expect(document.activeElement).toBe(editor)
  expect(dialog.getByRole('textbox', { name: 'Message body' })).toBe(editor)
  expect(dialog.getByRole('combobox', { name: 'To' })).toBe(recipient)
  expect(adapter.api.saveCompose).not.toHaveBeenCalled()
  expect(commits.get('SubjectField') ?? 0).toBe(0)
  expectBudget(keystrokeBudget)
})

it.each(['timestamp', 'immediate', 'staggered', 'off-reader'] as const)(
  'keeps open compose fields through a %s sync event',
  async (event) => {
    const { adapter, dialog, subject, editor, recipient } = await openComposer()
    act(() => subject.focus())
    const release = event === 'staggered' ? adapter.staggerReads() : undefined
    await act(async () => {
      if (event === 'timestamp') adapter.emitStatus({ lastSyncAt: Date.now() - 25_000 })
      else if (event === 'off-reader') {
        await adapter.api.setBucket({
          threadId: 'thread-2',
          bucket: 'Later',
          reason: 'Synthetic edit',
        })
      } else adapter.emitChanged()
    })
    for (const resolve of release?.() ?? []) await act(async () => resolve())
    expect(dialog.getByRole('textbox', { name: 'Subject' })).toBe(subject)
    expect(dialog.getByRole('textbox', { name: 'Message body' })).toBe(editor)
    expect(dialog.getByRole('combobox', { name: 'To' })).toBe(recipient)
    expect(document.activeElement).toBe(subject)
    expect(commits.get('SubjectField') ?? 0).toBe(0)
    expectBudget({
      workspace: 0,
      list: 0,
      reader: 0,
      rows: event === 'off-reader' ? 1 : 0,
      composer: 0,
      recipient: 0,
      footer: 0,
    })
  },
)

it('processes an unchanged draft poll while keeping the editor and subject mounted', async () => {
  const { adapter, dialog, subject, editor } = await openComposer()
  const initialSubject = subject.value
  const initialBody = editor.textContent
  adapter.api.composeDraft.mockClear()
  await act(async () => vi.advanceTimersByTimeAsync(1500))
  expect(adapter.api.composeDraft).toHaveBeenCalledExactlyOnceWith('draft-1')
  expect(dialog.getByRole('textbox', { name: 'Subject' })).toBe(subject)
  expect(subject.value).toBe(initialSubject)
  expect(dialog.getByRole('textbox', { name: 'Message body' })).toBe(editor)
  expect(editor.textContent).toBe(initialBody)
  expect(adapter.api.saveCompose).not.toHaveBeenCalled()
  expect(commits.get('SubjectField') ?? 0).toBe(0)
  expectBudget(keystrokeBudget)
})

it('saves one local burst and adopts a newer remote subject without replacing the editor', async () => {
  const { adapter, dialog, subject, editor } = await openComposer()
  await act(async () => fireEvent.change(subject, { target: { value: 'x' } }))
  await act(async () => vi.advanceTimersByTimeAsync(300))
  await act(async () => fireEvent.change(subject, { target: { value: 'xy' } }))
  await act(async () => vi.advanceTimersByTimeAsync(549))
  expect(adapter.api.saveCompose).not.toHaveBeenCalled()
  await act(async () => vi.advanceTimersByTimeAsync(1))
  expect(adapter.api.saveCompose).toHaveBeenCalledTimes(1)
  const saved = await adapter.api.saveCompose.mock.results[0].value
  expect(saved.subject).toBe('xy')
  adapter.api.composeDraft.mockResolvedValueOnce({
    ...saved,
    revision: saved.revision + 1,
    subject: 'Remote revision',
  })
  await act(async () => vi.advanceTimersByTimeAsync(650))
  expect(subject.value).toBe('Remote revision')
  expect(dialog.getByRole('textbox', { name: 'Message body' })).toBe(editor)
  expect(adapter.api.saveCompose).toHaveBeenCalledTimes(1)
})

it('flushes the edited subject and committed recipient after immediate renderer teardown', async () => {
  const { adapter, subject, recipient, dialog } = await openComposer()
  const db = new DatabaseSync(':memory:')
  try {
    const drafts = new LocalDraftUpdates(db)
    adapter.api.stageComposeBody.mockImplementation((id, patch) => drafts.stage(id, patch))
    await act(async () => {
      fireEvent.change(subject, { target: { value: 'Closing subject' } })
      fireEvent.change(recipient, { target: { value: 'closing@example.test' } })
      fireEvent.keyDown(recipient, { key: 'Enter' })
    })
    expect(dialog.getByRole('button', { name: 'Remove closing@example.test' })).toBeTruthy()
    cleanup()
    expect(adapter.api.saveCompose).not.toHaveBeenCalled()

    const request = vi
      .fn()
      .mockImplementation(async (_path, { body }: { body: ComposePatch }) =>
        adapter.api.saveCompose('draft-1', body),
      )
    await drafts.flush({ request })
    expect(request).toHaveBeenCalledExactlyOnceWith(
      '/v1/compose/drafts/draft-1',
      expect.objectContaining({ method: 'PUT' }),
    )
    expect(await adapter.api.composeDraft('draft-1')).toMatchObject({
      subject: 'Closing subject',
      to: [{ address: 'closing@example.test', name: null }],
    })
  } finally {
    db.close()
  }
})

const keystrokeBudget = {
  app: 0,
  workspace: 0,
  sidebar: 0,
  list: 0,
  reader: 0,
  rows: 0,
  composer: 0,
  recipient: 0,
  footer: 0,
}

it('keeps later header edits through a send racing an older autosave', async () => {
  const { adapter, dialog, subject, recipient } = await openComposer()
  const finishSave = deferred<void>()
  const save = adapter.api.saveCompose.getMockImplementation()
  if (!save) throw new Error('Missing draft save fixture')
  adapter.api.saveCompose.mockImplementationOnce(async (id, patch) => {
    const saved = await save(id, patch)
    await finishSave.promise
    return saved
  })
  const submit = adapter.api.sendDraft
  const send = vi
    .spyOn(adapter.api, 'sendDraft')
    .mockImplementation(async (request: SendRequest) => {
      const current = await adapter.api.composeDraft(request.draftId)
      if (request.revision !== current.revision) throw new Error(DRAFT_CHANGED)
      return submit(request)
    })
  const sendButton = dialog.getByRole('button', { name: /^Send ⌘/ })
  await act(async () => fireEvent.change(subject, { target: { value: 'Older subject' } }))
  await act(async () => vi.advanceTimersByTimeAsync(550))
  expect(adapter.api.saveCompose).toHaveBeenCalledOnce()

  await act(async () => {
    fireEvent.change(subject, { target: { value: 'Reviewed subject' } })
    fireEvent.change(recipient, { target: { value: 'reviewed@example.test' } })
    fireEvent.keyDown(recipient, { key: 'Enter' })
  })
  await act(async () => fireEvent.click(sendButton))
  expect(send).not.toHaveBeenCalled()
  await act(async () => finishSave.resolve())
  expect(send).toHaveBeenCalledOnce()
  const first = send.mock.calls[0][0]
  expect(first.revision).toBeLessThan((await adapter.api.composeDraft('draft-1')).revision)
  expect(dialog.getByRole('alert').textContent).toContain(DRAFT_CHANGED)
  expect(subject.value).toBe('Reviewed subject')
  expect(dialog.getByRole('button', { name: 'Remove reviewed@example.test' })).toBeTruthy()

  await act(async () => fireEvent.click(sendButton))
  expect(send).toHaveBeenCalledTimes(2)
  expect(send.mock.calls[1][0]).toMatchObject({
    revision: first.revision + 1,
    edits: {
      fields: {
        subject: 'Reviewed subject',
        to: [{ address: 'reviewed@example.test', name: null }],
      },
    },
  })
  expect(send.mock.calls[1][0].id).not.toBe(first.id)
  expect(screen.queryByRole('dialog', { name: 'Compose' })).toBeNull()
})

it('saves a focused recipient and subject on Escape before the autosave timer', async () => {
  const { adapter, subject, recipient } = await openComposer()
  await act(async () => {
    fireEvent.change(subject, { target: { value: 'Save before closing' } })
    recipient.focus()
    fireEvent.change(recipient, { target: { value: 'focused@example.test' } })
    fireEvent.keyDown(recipient, { key: 'Escape' })
  })
  expect(screen.queryByRole('dialog', { name: 'Compose' })).toBeNull()
  expect(adapter.api.saveCompose).toHaveBeenCalledExactlyOnceWith(
    'draft-1',
    expect.objectContaining({
      fields: expect.objectContaining({
        subject: 'Save before closing',
        to: [{ address: 'focused@example.test', name: null }],
      }),
    }),
  )
})

it('clears a remotely discarded minimised draft and starts a fresh draft from Compose', async () => {
  const { adapter, dialog } = await openComposer()
  await act(async () =>
    fireEvent.click(dialog.getByRole('button', { name: 'Minimise and save draft' })),
  )
  const tile = screen.getByRole('button', { name: 'Resume draft' })
  adapter.api.composeDraft.mockRejectedValueOnce(new Error('The Engine is offline'))
  await act(async () => vi.advanceTimersByTimeAsync(1500))
  expect(screen.getByRole('button', { name: 'Resume draft' })).toBe(tile)

  await adapter.api.discardDraft('draft-1', 1)
  await act(async () => vi.advanceTimersByTimeAsync(1500))
  expect(screen.queryByRole('button', { name: 'Resume draft' })).toBeNull()
  await act(async () => fireEvent.click(screen.getByRole('button', { name: /^Compose/ })))
  expect(await adapter.api.startCompose.mock.results[1]?.value).toMatchObject({ id: 'draft-2' })
  expect(screen.getByRole('dialog', { name: 'Compose' })).toBeTruthy()
})

it('closes a clean composer with a notice when its draft is discarded elsewhere', async () => {
  const { adapter } = await openComposer()
  adapter.api.composeDraft.mockRejectedValueOnce(
    new Error("Error invoking remote method 'amc:composeDraft': Error: Draft does not exist"),
  )
  await act(async () => vi.advanceTimersByTimeAsync(1500))
  expect(screen.queryByRole('dialog', { name: 'Compose' })).toBeNull()
  await act(async () => vi.advanceTimersByTimeAsync(100))
  expect(screen.getByText('This draft was discarded elsewhere')).toBeTruthy()
})

it('keeps unsaved body and headers in place and saves them into a new draft on request', async () => {
  const { adapter, dialog, subject, editor, recipient } = await openComposer()
  const finishPoll = deferred<void>()
  adapter.api.composeDraft.mockImplementationOnce(async () => {
    await finishPoll.promise
    throw new Error('Draft does not exist')
  })
  await act(async () => vi.advanceTimersByTimeAsync(1500))
  await adapter.api.discardDraft('draft-1', 1)
  await act(async () => {
    fireEvent.change(subject, { target: { value: 'Local subject' } })
    fireEvent.change(recipient, { target: { value: 'local@example.test' } })
    fireEvent.keyDown(recipient, { key: 'Enter' })
    const paragraph = editor.querySelector('p')
    if (!paragraph) throw new Error('Missing editor paragraph')
    editor.focus()
    const text = document.createTextNode('Local body')
    paragraph.replaceChildren(text)
    document.getSelection()?.collapse(text, text.length)
    fireEvent.input(editor, { data: text.data, inputType: 'insertText' })
  })
  await act(async () => finishPoll.resolve())
  await act(async () => vi.advanceTimersByTimeAsync(1500))
  expect(adapter.api.saveCompose).not.toHaveBeenCalled()
  expect(dialog.getByRole('alert').textContent).toContain('This draft was discarded elsewhere')
  expect(dialog.getByRole('textbox', { name: 'Message body' })).toBe(editor)
  expect(document.activeElement).toBe(editor)
  expect(editor.textContent).toBe('Local body')
  expect(subject.value).toBe('Local subject')

  const keep = dialog.getByRole('button', { name: 'Keep as new draft' })
  adapter.api.saveCompose.mockRejectedValueOnce(new Error('The Engine is offline'))
  await act(async () => fireEvent.click(keep))
  expect(dialog.getByRole('alert').textContent).toContain('The Engine is offline')
  expect(editor.textContent).toBe('Local body')
  await act(async () => fireEvent.click(keep))
  expect(adapter.api.startCompose).toHaveBeenCalledTimes(2)
  expect(adapter.api.saveCompose).toHaveBeenCalledTimes(2)
  expect(adapter.api.saveCompose).toHaveBeenLastCalledWith(
    'draft-2',
    expect.objectContaining({
      fields: expect.objectContaining({
        subject: 'Local subject',
        to: [{ address: 'local@example.test', name: null }],
      }),
    }),
  )
  const recovered = within(screen.getByRole('dialog', { name: 'Compose' }))
  expect(recovered.getByRole<HTMLInputElement>('textbox', { name: 'Subject' }).value).toBe(
    'Local subject',
  )
  expect(recovered.getByRole('textbox', { name: 'Message body' }).textContent).toBe('Local body')
  expect(recovered.queryByRole('alert')).toBeNull()
})

it('keeps an uncommitted recipient visible until the user chooses Close', async () => {
  const { adapter, dialog, recipient } = await openComposer()
  await act(async () => {
    recipient.focus()
    fireEvent.change(recipient, { target: { value: 'partial address' } })
  })
  await adapter.api.discardDraft('draft-1', 1)
  await act(async () => vi.advanceTimersByTimeAsync(1500))
  expect(adapter.api.stageComposeBody).not.toHaveBeenCalled()
  expect(dialog.getByRole('alert').textContent).toContain('This draft was discarded elsewhere')
  expect((recipient as HTMLInputElement).value).toBe('partial address')
  await act(async () => fireEvent.click(dialog.getByRole('button', { name: 'Close' })))
  expect(screen.queryByRole('dialog', { name: 'Compose' })).toBeNull()
  expect(adapter.api.saveCompose).not.toHaveBeenCalled()
})
