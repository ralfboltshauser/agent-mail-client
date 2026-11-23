import { execFileSync } from 'node:child_process'
import { act, createEvent, fireEvent, screen, within } from '@testing-library/react'
import { afterEach, expect, it, vi } from 'vitest'
import { deferred, rendererAdapter } from './adapter'
import { expectBudget } from './profile'
import { listbox, mount, reader, row } from './workspace'

const label = 'Copy thread reference'
const copyButton = () => screen.getByRole('button', { name: label })

function mockClipboard() {
  const writeText = vi.fn<(text: string) => Promise<void>>().mockResolvedValue(undefined)
  Object.defineProperty(navigator, 'clipboard', { configurable: true, value: { writeText } })
  return writeText
}

afterEach(() => Reflect.deleteProperty(navigator, 'clipboard'))

async function pressCopy(target: Element, shiftKey = true, repeat = false) {
  const event = createEvent.keyDown(target, {
    key: shiftKey ? 'C' : 'c',
    metaKey: true,
    shiftKey,
    repeat,
  })
  await act(async () => fireEvent(target, event))
  return event.defaultPrevented
}

it('copies the exact loaded Thread from the toolbar, shortcut and command palette', async () => {
  const id = "--imap:abc%40example.test/it's $(printf canary); :"
  const adapter = rendererAdapter()
  const readThreads = adapter.api.threads.getMockImplementation()
  const readThread = adapter.api.thread.getMockImplementation()
  if (!readThreads || !readThread) throw new Error('Expected synthetic mailbox reads')
  adapter.api.threads.mockImplementation(async (query) =>
    (await readThreads(query)).map((thread) =>
      thread.id === 'thread-1' ? { ...thread, id } : thread,
    ),
  )
  adapter.api.thread.mockImplementation(async (threadId) => {
    if (threadId !== id) return readThread(threadId)
    const detail = await readThread('thread-1')
    if (!detail) throw new Error('Expected the synthetic Thread')
    return { ...detail, thread: { ...detail.thread, id } }
  })
  const writeText = mockClipboard()
  await mount(adapter)
  const heading = reader()
  expect(copyButton().previousElementSibling?.getAttribute('aria-label')).toBe('Hand off')
  adapter.api.thread.mockClear()

  await act(async () => fireEvent.click(copyButton()))
  expectBudget({ workspace: 0, list: 0, reader: 0, rows: 0 })
  expect(await pressCopy(heading)).toBe(true)

  fireEvent.keyDown(heading, { key: 'k', metaKey: true })
  const palette = screen.getByRole('dialog')
  expect(await pressCopy(within(palette).getByRole('combobox'))).toBe(false)
  await act(async () => fireEvent.click(within(palette).getByText(label)))

  const command = writeText.mock.calls[0]?.[0] ?? ''
  expect(command).toMatch(/^amc thread --json -- '/)
  expect(writeText.mock.calls).toEqual([[command], [command], [command]])
  act(() => vi.advanceTimersByTime(0))
  expect(screen.getAllByText('Thread reference copied')).toHaveLength(3)
  // The stub receives arguments from a real shell without accessing an Engine.
  const argv = execFileSync('/bin/sh', ['-c', `amc() { printf '%s\\n' "$@"; }; ${command}`], {
    encoding: 'utf8',
  })
  expect(argv.trimEnd().split('\n')).toEqual(['thread', '--json', '--', id])
  expect(adapter.api.thread).not.toHaveBeenCalled()
  expect(adapter.api.startCompose).not.toHaveBeenCalled()
  expect(reader()).toBe(heading)

  fireEvent.keyDown(heading, { key: '?' })
  const shortcuts = screen.getByRole('dialog', { name: 'Keyboard shortcuts' })
  expect(within(shortcuts).getByText(label).nextElementSibling?.textContent).toBe('⌘⇧C')
})

it('leaves ordinary copy, editable controls, selection and composer shortcuts alone', async () => {
  const writeText = mockClipboard()
  await mount()
  const heading = reader()
  expect(await pressCopy(heading, false)).toBe(false)
  expect(await pressCopy(heading, true, true)).toBe(false)
  expect(await pressCopy(screen.getByRole('textbox', { name: /Filter mail/ }))).toBe(false)

  const selection = window.getSelection()
  selection?.selectAllChildren(heading)
  expect(selection?.isCollapsed).toBe(false)
  try {
    expect(await pressCopy(heading)).toBe(false)
  } finally {
    selection?.removeAllRanges()
  }

  await act(async () => fireEvent.click(screen.getByRole('button', { name: /^Compose/ })))
  const composer = within(screen.getByRole('dialog', { name: 'Compose' }))
  expect(await pressCopy(composer.getByRole('textbox', { name: 'Message body' }))).toBe(false)
  expect(writeText).not.toHaveBeenCalled()
})

it('copies the new selection after an older read resolves and reports clipboard failure', async () => {
  const writeText = mockClipboard()
  const adapter = await mount()
  const previous = await adapter.api.thread('thread-2')
  const slow = deferred<typeof previous>()
  adapter.api.thread.mockImplementationOnce(() => slow.promise)

  await act(async () => fireEvent.click(row('Sunday at the studio')))
  expect(screen.queryByRole('button', { name: label })).toBeNull()
  expect(await pressCopy(listbox())).toBe(false)

  await act(async () => fireEvent.click(row('Invoice for the spring issue')))
  await act(async () => slow.resolve(previous))
  writeText.mockRejectedValueOnce(new Error('Clipboard unavailable'))
  await act(async () => fireEvent.click(copyButton()))
  act(() => vi.advanceTimersByTime(0))
  expect(writeText).toHaveBeenCalledExactlyOnceWith("amc thread --json -- 'thread-3'")
  expect(screen.getByText('Could not copy thread reference')).toBeTruthy()
})
