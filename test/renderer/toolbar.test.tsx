import { act, fireEvent, screen, within } from '@testing-library/react'
import { expect, it, vi } from 'vitest'
import { expectBudget } from './profile'
import { listbox, mount, reader, selected } from './workspace'

function expectHint(trigger: HTMLElement, label: string, ...keys: string[]) {
  const hint = screen.getByRole('tooltip')
  expect(hint.id).toBe(trigger.getAttribute('aria-describedby'))
  expect(hint.textContent).toBe(label + keys.join(''))
}

it('exposes mailbox toolbar actions and their bindings on hover and focus', async () => {
  await mount()
  const actions = within(screen.getByRole('group', { name: 'Thread actions' }))
  const copy = actions.getByRole('button', { name: 'Copy thread reference' })
  fireEvent.pointerMove(copy, { pointerType: 'mouse' })
  act(() => vi.advanceTimersByTime(699))
  expect(screen.queryByRole('tooltip')).toBeNull()
  act(() => vi.advanceTimersByTime(1))
  expectHint(copy, 'Copy thread reference', '⌘⇧C')
  expect(copy.getAttribute('aria-keyshortcuts')).toBe('Meta+Shift+C')
  expect(copy.textContent).toBe('')

  const bucket = actions.getByRole('button', { name: 'Bucket: Reply' })
  act(() => bucket.focus())
  expectHint(bucket, 'Choose a Bucket · Current: Reply', 'B')
  fireEvent.keyDown(bucket, { key: 'b' })
  expect(screen.getByRole('menu')).toBeTruthy()
  fireEvent.keyDown(screen.getByRole('menu'), { key: 'Escape' })
  act(() => vi.advanceTimersByTime(0))

  const compose = screen.getByRole('button', { name: 'Compose' })
  act(() => compose.focus())
  expectHint(compose, 'Compose', 'C')

  fireEvent.keyDown(compose, { key: 'f', metaKey: true })
  const search = screen.getByRole('textbox', { name: /^Filter mail/ })
  expect(document.activeElement).toBe(search)
  expectHint(search, 'Filter mail or search all mail', '/', '⌘F')
  fireEvent.change(search, { target: { value: 'Field' } })
  const clear = screen.getByRole('button', { name: 'Clear search' })
  act(() => clear.focus())
  expectHint(clear, 'Clear search', 'Esc')
  fireEvent.keyDown(clear, { key: 'Escape' })
  expect((search as HTMLInputElement).value).toBe('')

  const focus = screen.getByRole('button', { name: 'Focus reader' })
  act(() => focus.focus())
  expectHint(focus, 'Focus reader', 'O')
  fireEvent.keyDown(focus, { key: 'o' })
  const back = screen.getByRole('button', { name: 'Back to mailbox' })
  expect(back).toBe(focus)
  act(() => back.focus())
  expectHint(back, 'Back to mailbox', 'Esc', 'O')
  fireEvent.keyDown(back, { key: 'Escape' })
  expect(screen.getByRole('button', { name: 'Focus reader' })).toBe(focus)
})

it('keeps action and mailbox nodes across refresh and a read toggle', async () => {
  const adapter = await mount()
  const actions = within(screen.getByRole('group', { name: 'Thread actions' }))
  const read = actions.getByRole('button', { name: /^Mark as / })
  const originalName = read.getAttribute('aria-label')
  const [list, selection, heading] = [listbox(), selected(), reader()]
  act(() => read.focus())

  await act(async () => adapter.emitChanged())
  expect(actions.getByRole('button', { name: /^Mark as / })).toBe(read)
  expect(document.activeElement).toBe(read)
  expectBudget({ workspace: 0, list: 0, reader: 0, rows: 0 })

  await act(async () => fireEvent.click(read))
  const changed = actions.getByRole('button', { name: /^Mark as / })
  expect(changed).toBe(read)
  expect(changed.getAttribute('aria-label')).not.toBe(originalName)
  expect(document.activeElement).toBe(read)
  expect(listbox()).toBe(list)
  expect(selected()).toBe(selection)
  expect(reader()).toBe(heading)
})
