import { act, fireEvent, screen } from '@testing-library/react'
import { expect, it } from 'vitest'
import { expectBudget } from './profile'
import { listbox, mount, reader, selected } from './workspace'

it('starts with both sidebar sections closed and toggles them independently', async () => {
  const adapter = await mount()
  const triage = screen.getByRole('button', { name: 'Triage', expanded: false })
  const labels = screen.getByRole('button', { name: 'Labels', expanded: false })
  const inbox = screen.getByRole('button', { name: 'Inbox', current: 'page' })
  const list = listbox()
  const thread = selected()
  const heading = reader()
  expect(screen.queryByRole('button', { name: 'Run recent' })).toBeNull()
  expect(screen.queryByRole('button', { name: 'Later' })).toBeNull()
  expect(screen.queryByRole('button', { name: 'Editorial' })).toBeNull()
  expect(adapter.api.triageCounts).not.toHaveBeenCalled()

  await act(async () => fireEvent.click(triage))
  expect(screen.getByRole('button', { name: 'Triage', expanded: true })).toBe(triage)
  expect(screen.getByRole('button', { name: 'Labels', expanded: false })).toBe(labels)
  expect(screen.getByText('No triage runs yet')).toBeTruthy()
  expect(screen.getByRole('button', { name: 'Run recent' })).toBeTruthy()
  const bucket = screen.getByRole('button', { name: 'Later' })

  await act(async () => fireEvent.click(labels))
  expect(screen.getByRole('button', { name: 'Labels', expanded: true })).toBe(labels)
  expect(screen.getByRole('button', { name: 'Later' })).toBe(bucket)
  const label = screen.getByRole('button', { name: 'Editorial' })

  act(() => label.focus())
  await act(async () => fireEvent.click(triage))
  expect(screen.getByRole('button', { name: 'Triage', expanded: false })).toBe(triage)
  expect(screen.queryByRole('button', { name: 'Later' })).toBeNull()
  expect(screen.queryByRole('button', { name: 'Run recent' })).toBeNull()
  expect(screen.getByRole('button', { name: 'Editorial' })).toBe(label)
  expect(document.activeElement).toBe(label)
  expect(screen.getByRole('button', { name: 'Inbox', current: 'page' })).toBe(inbox)
  expect(listbox()).toBe(list)
  expect(selected()).toBe(thread)
  expect(reader()).toBe(heading)
  expectBudget({ sidebar: 0, workspace: 0, list: 0, reader: 0, rows: 0 })

  await act(async () => fireEvent.click(label))
  expect(screen.getByRole('heading', { name: 'Editorial' })).toBeTruthy()
  await act(async () => fireEvent.click(labels))
  expect(screen.getByRole('heading', { name: 'Editorial' })).toBeTruthy()
  expect(screen.queryByRole('button', { name: 'Editorial' })).toBeNull()

  await act(async () => fireEvent.click(triage))
  await act(async () => fireEvent.click(screen.getByRole('button', { name: 'Later' })))
  expect(screen.getByRole('heading', { name: 'Later' })).toBeTruthy()
  await act(async () => fireEvent.click(triage))
  expect(screen.getByRole('heading', { name: 'Later' })).toBeTruthy()
})

it.each(['Enter', ' '])('allows native keyboard activation with %j in the sidebar', async (key) => {
  await mount()
  const labels = screen.getByRole('button', { name: 'Labels', expanded: false })
  expect(labels).toBeInstanceOf(HTMLButtonElement)
  expect(labels.tabIndex).toBe(0)
  act(() => labels.focus())

  await act(async () => {
    expect(fireEvent.keyDown(labels, { key })).toBe(true)
    expect(fireEvent.keyUp(labels, { key })).toBe(true)
    // jsdom does not synthesize the native button click from these key events.
    fireEvent.click(labels, { detail: 0 })
  })

  expect(screen.getByRole('button', { name: 'Labels', expanded: true })).toBe(labels)
  expect(screen.getByRole('button', { name: 'Triage', expanded: false })).toBeTruthy()
  expect(document.activeElement).toBe(labels)
})
