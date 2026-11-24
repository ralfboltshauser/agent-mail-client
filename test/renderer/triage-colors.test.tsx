import { act, cleanup, fireEvent, screen, within } from '@testing-library/react'
import { expect, it, vi } from 'vitest'
import { rendererAdapter } from './adapter'
import { commits, expectBudget } from './profile'
import { listbox, mount, reader, selected } from './workspace'

it('updates triage badges in place, preserves the choice on failure, and restores it on startup', async () => {
  const replyKey = 'amc.triage-color.v1:bucket.reply'
  const actionKey = 'amc.triage-color.v1:bucket.action'
  const rootStyle = document.documentElement.style
  const replyColor = () => rootStyle.getPropertyValue('--triage-color-reply')
  const actionColor = () => rootStyle.getPropertyValue('--triage-color-action')
  localStorage.setItem(replyKey, 'Rose')
  localStorage.setItem(actionKey, 'invalid')

  const adapter = await mount()
  const list = listbox()
  const row = selected()
  const title = reader()
  const badges = Array.from(document.querySelectorAll('[data-triage-bucket="bucket.reply"]'))
  expect(badges).toHaveLength(3)
  expect(
    badges.every((badge) => badge.getAttribute('style')?.includes('--triage-color-reply')),
  ).toBe(true)
  expect(replyColor()).toBe('var(--triage-palette-rose)')
  expect(actionColor()).toBe('')

  act(() => list.focus())
  await act(async () => adapter.emitOpenSettings())
  const dialog = screen.getByRole('dialog', { name: 'Settings' })
  const picker = within(dialog).getByRole('combobox', { name: 'Reply color' })
  expect(picker).toHaveProperty('value', 'Rose')
  expect(within(dialog).getByRole('combobox', { name: 'Action color' })).toHaveProperty(
    'value',
    'Default',
  )
  adapter.api.threads.mockClear()
  commits.clear()

  fireEvent.change(picker, { target: { value: 'Neutral' } })
  expect(picker).toHaveProperty('value', 'Neutral')
  expect(localStorage.getItem(replyKey)).toBe('Neutral')
  expect(replyColor()).toBe('var(--triage-palette-neutral)')
  expect(actionColor()).toBe('')
  expect(adapter.api.threads).not.toHaveBeenCalled()
  expectBudget({ app: 0, workspace: 0, list: 0, rows: 0, reader: 0 })

  act(() => picker.focus())
  vi.spyOn(localStorage, 'setItem').mockImplementationOnce(() => {
    throw new Error('Storage unavailable')
  })
  fireEvent.change(picker, { target: { value: 'Blue' } })
  expect(picker).toHaveProperty('value', 'Neutral')
  expect(document.activeElement).toBe(picker)
  expect(replyColor()).toBe('var(--triage-palette-neutral)')
  expect(localStorage.getItem(replyKey)).toBe('Neutral')

  await act(async () => {
    fireEvent.keyDown(picker, { key: 'Escape' })
    await vi.advanceTimersByTimeAsync(0)
  })
  expect(listbox()).toBe(list)
  expect(selected()).toBe(row)
  expect(reader()).toBe(title)
  expect(Array.from(document.querySelectorAll('[data-triage-bucket="bucket.reply"]'))).toEqual(
    badges,
  )
  expect(document.activeElement).toBe(list)

  cleanup()
  rootStyle.removeProperty('--triage-color-reply')
  const restarted = await mount(rendererAdapter())
  expect(replyColor()).toBe('var(--triage-palette-neutral)')
  await act(async () => restarted.emitOpenSettings())
  const reopened = screen.getByRole('combobox', { name: 'Reply color' })
  expect(reopened).toHaveProperty('value', 'Neutral')
  fireEvent.change(reopened, { target: { value: 'Default' } })
  expect(reopened).toHaveProperty('value', 'Default')
  expect(localStorage.getItem(replyKey)).toBeNull()
  expect(replyColor()).toBe('')
})
