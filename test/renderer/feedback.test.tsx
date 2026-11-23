import { act, fireEvent, screen, waitFor } from '@testing-library/react'
import { describe, expect, it, vi } from 'vitest'
import { rendererAdapter } from './adapter'
import { expectBudget } from './profile'
import { listbox, mount, reader } from './workspace'

const panel = () => screen.queryByRole('region', { name: 'Send Feedback' })
const toolbar = () => document.querySelector('agentation-toolbar')?.shadowRoot
const button = (label: string) =>
  toolbar()?.querySelector<HTMLButtonElement>(`button[aria-label="${label}"]`)

function clickToolbar(label: string) {
  const control = button(label)
  if (!control) throw new Error(`Missing Agentation button: ${label}`)
  fireEvent.click(control)
}

async function openFeedback(adapter: ReturnType<typeof rendererAdapter>) {
  vi.useRealTimers()
  await act(async () => adapter.emitFeedback())
  await waitFor(() => expect(button('Exit')?.getAttribute('aria-expanded')).toBe('true'))
}

async function pickElement(target: HTMLElement) {
  const original = document.elementFromPoint
  document.elementFromPoint = () => target
  try {
    fireEvent.click(target, { clientX: 100, clientY: 150 })
    await waitFor(() => expect(toolbar()?.querySelector('textarea')).toBeTruthy())
  } finally {
    document.elementFromPoint = original
  }
}

describe('desktop feedback', () => {
  it('opens Agentation immediately and exits without taking a screenshot or changing mailbox commits', async () => {
    const adapter = await mount()
    const originalList = listbox()
    const originalReader = reader()
    originalList.focus()

    const store = vi.spyOn(localStorage, 'setItem')
    await openFeedback(adapter)
    expect(panel()).toBeNull()
    await pickElement(originalReader)
    expect(store.mock.calls.filter(([key]) => key.startsWith('feedback-annotations-'))).toEqual([])
    fireEvent.keyDown(window, { key: 'Escape' })

    expect(panel()).toBeNull()
    expect(toolbar()).toBeUndefined()
    expect(store.mock.calls.filter(([key]) => key.startsWith('feedback-annotations-'))).toEqual([])
    expect(adapter.api.feedback.capture).not.toHaveBeenCalled()
    expect(document.activeElement).toBe(originalList)
    expect(listbox()).toBe(originalList)
    expect(reader()).toBe(originalReader)
    expectBudget({ app: 0, workspace: 0, list: 0, reader: 0, rows: 0 })

    await openFeedback(adapter)
    expect(toolbar()?.querySelector('[data-annotation-marker]')).toBeNull()
    clickToolbar('Exit')
    expect(panel()).toBeNull()
  })

  it('accepts Cmd+Enter with only a general note', async () => {
    const adapter = await mount()
    await openFeedback(adapter)
    expect(panel()).toBeNull()
    fireEvent.keyDown(window, { key: 'Enter', metaKey: true })
    const note = screen.getByRole('textbox', { name: 'General feedback note' })
    fireEvent.change(note, { target: { value: 'More room here' } })
    fireEvent.keyDown(note, { key: 'Enter', metaKey: true })

    await waitFor(() => expect(adapter.api.feedback.send).toHaveBeenCalledTimes(1))
    expect(panel()).toBeNull()
    expect(await screen.findByText('Opened in T3')).toBeTruthy()
    expect(adapter.api.feedback.capture).toHaveBeenCalledExactlyOnceWith('inbox')
    expect(adapter.api.feedback.send).toHaveBeenCalledExactlyOnceWith('renderer-fixture', {
      text: 'More room here',
      markdown: '',
    })
    expectBudget({ workspace: 0, list: 0, reader: 0, rows: 0 })
  })

  it('keeps the finished prompt in memory for offline Copy feedback', async () => {
    const adapter = rendererAdapter()
    adapter.api.feedback.send.mockResolvedValueOnce({
      opened: false,
      reason: 'AMC could not find a local T3 connection.',
    })
    await mount(adapter)
    const store = vi.spyOn(localStorage, 'setItem')
    await openFeedback(adapter)
    fireEvent.keyDown(window, { key: 'Enter', metaKey: true })
    fireEvent.change(screen.getByRole('textbox', { name: 'General feedback note' }), {
      target: { value: 'Adjust spacing' },
    })
    expect(adapter.api.feedback.capture).not.toHaveBeenCalled()
    fireEvent.keyDown(window, { key: 'Enter', metaKey: true })
    await waitFor(() => expect(adapter.api.feedback.send).toHaveBeenCalledTimes(1))
    const copy = await screen.findByRole('button', { name: 'Copy feedback' })
    expect(screen.getByRole('alert').textContent).toBe('AMC could not find a local T3 connection.')
    await waitFor(() =>
      expect(screen.getAllByText('AMC could not find a local T3 connection.')).toHaveLength(2),
    )
    fireEvent.click(copy)

    const draft = { text: 'Adjust spacing', markdown: '' }
    expect(adapter.api.feedback.send).toHaveBeenCalledExactlyOnceWith('renderer-fixture', draft)
    expect(adapter.api.feedback.copy).toHaveBeenCalledExactlyOnceWith('renderer-fixture', draft)
    expect(toolbar()).toBeUndefined()
    expect(store.mock.calls.filter(([key]) => key.startsWith('feedback-annotations-'))).toEqual([])
    expectBudget({ workspace: 0, list: 0, reader: 0, rows: 0 })
  })
})
