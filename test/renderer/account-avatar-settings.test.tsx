import { act, fireEvent, screen, within } from '@testing-library/react'
import { expect, it, vi } from 'vitest'
import { rendererAdapter } from './adapter'
import { commits, expectBudget } from './profile'
import { listbox, mount, reader, selected } from './workspace'

it('applies each account shape independently and preserves the selected mail', async () => {
  const adapter = rendererAdapter()
  const [studio] = await adapter.api.accounts()
  adapter.api.accounts.mockResolvedValue([
    studio,
    { ...studio, id: 'personal', address: 'personal@example.test', displayName: 'Personal' },
  ])
  await mount(adapter)

  const list = listbox()
  const row = selected()
  const title = reader()
  const inboxAvatar = row.querySelector('[data-avatar-shape]')
  const readerAvatar = document.querySelector('button[aria-expanded] [data-avatar-shape]')
  expect(inboxAvatar?.getAttribute('data-avatar-shape')).toBe('circle')
  expect(readerAvatar?.getAttribute('data-avatar-shape')).toBe('circle')

  act(() => list.focus())
  await act(async () => adapter.emitOpenSettings())
  const dialog = screen.getByRole('dialog', { name: 'Settings' })
  const account = within(dialog).getByRole('group', { name: /jules@example.test/ })
  const personal = within(dialog).getByRole('group', { name: /personal@example.test/ })
  const studioBlob = within(account).getByRole('radio', { name: 'Blob' })
  const personalSquare = within(personal).getByRole('radio', { name: 'Square' })
  adapter.api.threads.mockClear()
  commits.clear()

  await act(async () => fireEvent.click(personalSquare))
  expect(personalSquare).toHaveProperty('checked', true)
  expect(inboxAvatar?.getAttribute('data-avatar-shape')).toBe('circle')
  expect(readerAvatar?.getAttribute('data-avatar-shape')).toBe('circle')

  await act(async () => fireEvent.click(studioBlob))
  expect(studioBlob).toHaveProperty('checked', true)
  expect(personalSquare).toHaveProperty('checked', true)
  expect(inboxAvatar?.getAttribute('data-avatar-shape')).toBe('blob')
  expect(readerAvatar?.getAttribute('data-avatar-shape')).toBe('blob')
  expect(adapter.api.threads).not.toHaveBeenCalled()
  expectBudget({ workspace: 0, list: 0, rows: 0 })

  const failedWrite = vi.spyOn(localStorage, 'setItem').mockImplementationOnce(() => {
    throw new Error('Storage unavailable')
  })
  const studioDiamond = within(account).getByRole('radio', { name: 'Diamond' })
  await act(async () => fireEvent.click(studioDiamond))
  expect(studioBlob).toHaveProperty('checked', true)
  expect(inboxAvatar?.getAttribute('data-avatar-shape')).toBe('blob')
  failedWrite.mockRestore()

  await act(async () => {
    fireEvent.keyDown(studioBlob, { key: 'Escape' })
    await vi.advanceTimersByTimeAsync(0)
  })
  expect(screen.queryByRole('dialog', { name: 'Settings' })).toBeNull()
  expect(listbox()).toBe(list)
  expect(selected()).toBe(row)
  expect(reader()).toBe(title)
  expect(row.querySelector('[data-avatar-shape]')).toBe(inboxAvatar)
  expect(document.activeElement).toBe(list)
})
