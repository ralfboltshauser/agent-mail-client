// @vitest-environment jsdom

import type { ThreadSummary } from '@amc/protocol'
import { act, createElement } from 'react'
import { createRoot } from 'react-dom/client'
import { afterEach, expect, it, vi } from 'vitest'
import { ThreadList } from '@/components/thread-list'
import { createMailFixture } from '@/dev/mail-fixture'

const { renderPaperclip } = vi.hoisted(() => ({ renderPaperclip: vi.fn(() => null) }))

vi.mock('lucide-react', async (importOriginal) => ({
  ...(await importOriginal<typeof import('lucide-react')>()),
  Paperclip: renderPaperclip,
}))

afterEach(() => {
  vi.restoreAllMocks()
  vi.unstubAllGlobals()
})

it('keeps virtual rows and keyboard focus keyed by ID as replica replies reorder the list', async () => {
  vi.stubGlobal('IS_REACT_ACT_ENVIRONMENT', true)
  vi.stubGlobal('amc', createMailFixture('inbox').api)
  vi.spyOn(HTMLElement.prototype, 'offsetHeight', 'get').mockReturnValue(360)
  vi.spyOn(HTMLElement.prototype, 'offsetWidth', 'get').mockReturnValue(420)
  vi.spyOn(HTMLElement.prototype, 'scrollHeight', 'get').mockReturnValue(74 * 60)
  vi.spyOn(HTMLElement.prototype, 'clientHeight', 'get').mockReturnValue(360)

  const root = createRoot(document.body)
  const select = vi.fn()
  const move = vi.fn()
  const threads = Array.from(
    { length: 60 },
    (_, n): ThreadSummary => ({
      id: `thread-${n}`,
      accountId: 'mail',
      subject: `Subject ${n}`,
      snippet: 'Preview',
      participants: [{ address: 'owner@example.com', name: 'Owner' }],
      messageCount: 1,
      unreadCount: 0,
      labelIds: [],
      starred: false,
      inInbox: true,
      hasAttachments: true,
      lastMessageAt: n,
      snoozedUntil: null,
      muted: false,
    }),
  )

  const render = (rows: ThreadSummary[], selectedId: string | null) =>
    act(async () =>
      root.render(
        createElement(ThreadList, {
          ids: rows.map((row) => row.id),
          query: null,
          fallbackRows: new Map(rows.map((row) => [row.id, row])),
          selectedId,
          onSelect: (id) => select(id),
          onMove: move,
          self: new Set(['owner@example.com']),
          empty: null,
        }),
      ),
    )
  const option = (id: string) => document.querySelector<HTMLDivElement>(`[data-thread-id="${id}"]`)

  try {
    await render(threads, null)
    const list = document.querySelector<HTMLDivElement>('[role=listbox]')
    const viewport = list?.closest('[data-thread-viewport]')
    const selected = option('thread-3')
    const sibling = option('thread-4')
    if (!list || !viewport || !selected || !sibling)
      throw new Error('Expected mounted virtual options')
    expect(document.querySelectorAll('[role=option]').length).toBeLessThan(threads.length)
    const scrollTo = vi.fn()
    Object.defineProperty(viewport, 'scrollTo', { value: scrollTo })

    await act(async () => selected.click())
    expect(select).toHaveBeenCalledWith('thread-3')
    expect(document.activeElement).toBe(list)

    await render(structuredClone(threads), 'thread-3')
    expect(list.getAttribute('aria-activedescendant')).toBe(selected.id)

    renderPaperclip.mockClear()
    const refreshed = structuredClone(threads)
    const changed = refreshed.find((thread) => thread.id === 'thread-5')
    if (!changed) throw new Error('Expected thread-5')
    changed.subject = 'Updated subject'
    await render(refreshed, 'thread-3')
    expect(option('thread-5')?.textContent).toContain('Updated subject')
    expect(renderPaperclip).toHaveBeenCalledTimes(1)

    renderPaperclip.mockClear()
    await render(structuredClone(refreshed), 'thread-3')
    expect(renderPaperclip).not.toHaveBeenCalled()

    scrollTo.mockClear()
    // Sync inserts a row above the viewport and moves the active thread outside overscan.
    await render(
      [
        { ...changed, id: 'inserted' },
        ...refreshed.filter((thread) => thread.id !== 'thread-3'),
        ...refreshed.filter((thread) => thread.id === 'thread-3'),
      ],
      'thread-3',
    )
    expect(option('thread-3')).toBe(selected)
    expect(option('thread-4')).toBe(sibling)
    expect(selected.getAttribute('aria-posinset')).toBe('61')
    expect(selected.style.transform).toBe('translateY(4440px)')
    expect(scrollTo).not.toHaveBeenCalled()
    expect(document.getElementById(list.getAttribute('aria-activedescendant') ?? '')).toBe(selected)
    expect(document.activeElement).toBe(list)

    await act(async () => {
      list.dispatchEvent(new KeyboardEvent('keydown', { key: 'ArrowDown', bubbles: true }))
    })
    expect(move).toHaveBeenCalledWith(1)

    await render(
      refreshed.filter((thread) => thread.id !== 'thread-3'),
      'thread-3',
    )
    expect(list.hasAttribute('aria-activedescendant')).toBe(false)
    expect(selected.isConnected).toBe(false)
    expect(document.activeElement).toBe(list)

    await render(refreshed, 'thread-59')
    expect(scrollTo.mock.calls.some(([offset]) => offset.top > 0)).toBe(true)
    expect(document.getElementById(list.getAttribute('aria-activedescendant') ?? '')).toBe(
      option('thread-59'),
    )
  } finally {
    await act(async () => root.unmount())
  }
})
