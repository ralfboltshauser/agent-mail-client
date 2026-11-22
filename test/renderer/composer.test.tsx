import { act, fireEvent, screen, within } from '@testing-library/react'
import { expect, it, vi } from 'vitest'
import { commits, expectBudget } from './profile'
import { mount } from './workspace'

async function openComposer() {
  const adapter = await mount()
  await act(async () => fireEvent.click(screen.getByRole('button', { name: /^Compose/ })))
  const dialog = within(screen.getByRole('dialog', { name: 'Compose' }))
  const subject = dialog.getByRole<HTMLInputElement>('textbox', { name: 'Subject' })
  const editor = dialog.getByRole('textbox', { name: 'Message body' })
  const recipient = dialog.getByRole('combobox', { name: 'To' })
  for (const region of ['Composer', 'RecipientField', 'footer']) {
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
  expect(adapter.api.stageComposeBody).not.toHaveBeenCalled()
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
  expectBudget(keystrokeBudget)
})

it('keeps open compose fields through a no-op replica event', async () => {
  const { adapter, dialog, subject, editor, recipient } = await openComposer()
  await act(async () => adapter.emitChanged())
  expect(dialog.getByRole('textbox', { name: 'Subject' })).toBe(subject)
  expect(dialog.getByRole('textbox', { name: 'Message body' })).toBe(editor)
  expect(dialog.getByRole('combobox', { name: 'To' })).toBe(recipient)
  expectBudget({ workspace: 2, list: 2, reader: 2, rows: 2, composer: 2, recipient: 2, footer: 2 })
})

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
  expectBudget({ workspace: 0, list: 0, reader: 0, rows: 0, composer: 1, recipient: 1, footer: 1 })
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

const keystrokeBudget = {
  app: 0,
  workspace: 0,
  sidebar: 0,
  list: 0,
  reader: 0,
  rows: 0,
  composer: 1,
  recipient: 1,
  footer: 1,
}

it.todo(
  'Phase 2: a subject or body character commits no mailbox, recipient or unchanged footer and at most one edited region',
)
it.todo('Phase 2: an unchanged clean-draft poll commits zero composer content')
