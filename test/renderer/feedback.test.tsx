import { act, fireEvent, screen, waitFor, within } from '@testing-library/react'
import { describe, expect, it, vi } from 'vitest'
import { rendererAdapter } from './adapter'
import { expectBudget } from './profile'
import { listbox, mount, reader } from './workspace'

async function openFeedback(adapter: ReturnType<typeof rendererAdapter>) {
  // The real lazy chunk resolves on the module loader's clock.
  vi.useRealTimers()
  await act(async () => adapter.emitFeedback())
  return screen.findByRole('dialog', { name: 'Send Feedback' })
}

describe('desktop feedback', () => {
  it('captures once, opens with no mailbox commits, and closes with Escape', async () => {
    const adapter = await mount()
    const originalList = listbox()
    const originalReader = reader()
    const dialog = await openFeedback(adapter)
    expect(adapter.api.feedback.capture).toHaveBeenCalledExactlyOnceWith('inbox', {
      width: innerWidth,
      height: innerHeight,
    })
    const text = within(dialog).getByRole('textbox', { name: 'What’s wrong / what do you want?' })
    expect(document.activeElement).toBe(text)
    fireEvent.change(text, { target: { value: 'More room here' } })
    // Chromium fires the native cancel event on Escape. JSDOM does not drive native dialogs.
    fireEvent(dialog, new Event('cancel', { cancelable: true, bubbles: false }))
    expect(screen.queryByRole('dialog', { name: 'Send Feedback' })).toBeNull()
    expect(adapter.api.feedback.send).not.toHaveBeenCalled()
    expect(listbox()).toBe(originalList)
    expect(reader()).toBe(originalReader)
    expectBudget({ app: 0, workspace: 0, list: 0, reader: 0, rows: 0 })
  })

  it('accepts Cmd+Enter with empty feedback', async () => {
    const adapter = await mount()
    const dialog = await openFeedback(adapter)
    fireEvent.keyDown(within(dialog).getByRole('textbox'), { key: 'Enter', metaKey: true })
    await waitFor(() => expect(screen.queryByRole('dialog', { name: 'Send Feedback' })).toBeNull())
    expect(adapter.api.feedback.send).toHaveBeenCalledExactlyOnceWith('renderer-fixture', {
      text: '',
      annotations: [],
    })
    expectBudget({ workspace: 0, list: 0, reader: 0, rows: 0 })
  })

  it('toggles the picker, captures a structural annotation, and copies feedback on launch failure', async () => {
    const adapter = rendererAdapter()
    adapter.api.feedback.send.mockRejectedValueOnce(new Error('offline'))
    await mount(adapter)
    const dialog = await openFeedback(adapter)
    fireEvent.click(within(dialog).getByRole('button', { name: 'Annotate' }))
    fireEvent.click(screen.getByRole('button', { name: 'Done' }))
    fireEvent.click(within(dialog).getByRole('button', { name: 'Annotate' }))
    const picker = screen.getByRole('button', { name: 'Pick an element to annotate' })
    vi.stubGlobal('CSS', { escape: (tag: string) => tag })
    Object.defineProperty(document, 'elementsFromPoint', {
      configurable: true,
      value: () => [picker, reader()],
    })
    try {
      fireEvent.click(picker)
    } finally {
      Reflect.deleteProperty(document, 'elementsFromPoint')
    }
    fireEvent.change(within(dialog).getByRole('textbox', { name: 'Annotation 1' }), {
      target: { value: 'Add spacing' },
    })
    fireEvent.click(within(dialog).getByRole('button', { name: 'Add note' }))
    fireEvent.click(within(dialog).getByRole('button', { name: 'Skip text, open in T3' }))
    const copy = await within(dialog).findByRole('button', { name: 'Copy feedback' })
    fireEvent.click(copy)
    const draft = {
      text: '',
      annotations: [
        expect.objectContaining({
          selector: expect.stringMatching(/ > h1$/),
          component: expect.any(String),
          note: 'Add spacing',
        }),
      ],
    }
    expect(adapter.api.feedback.send).toHaveBeenCalledExactlyOnceWith('renderer-fixture', draft)
    expect(adapter.api.feedback.copy).toHaveBeenCalledExactlyOnceWith('renderer-fixture', draft)
    expectBudget({ workspace: 0, list: 0, reader: 0, rows: 0 })
  })
})
