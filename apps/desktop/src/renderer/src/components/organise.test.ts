// @vitest-environment jsdom

import type { OrganiseAction, ThreadSummary } from '@amc/protocol'
import { act, createElement, useState } from 'react'
import { createRoot } from 'react-dom/client'
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import { useHotkeys } from '../hooks/use-hotkeys'
import { navigableLabels } from './app-sidebar'
import { OrganisePicker, OrganiseToolbar, useOrganise } from './organise'
import { ThreadView } from './thread-view'
import { TooltipProvider } from './ui/tooltip'

const thread = {
  id: 'a:thread',
  accountId: 'a',
  subject: 'Synthetic thread',
  labelIds: [],
  unreadCount: 0,
  starred: false,
} as unknown as ThreadSummary

const mockRun = vi.fn<(action: OrganiseAction, description: string) => Promise<void>>()

function Fixture({
  kind,
  snoozeEnabled = true,
}: {
  kind: 'labels' | 'snooze' | 'trash'
  snoozeEnabled?: boolean
}) {
  const organise = useOrganise(thread, snoozeEnabled)
  const [selection, setSelection] = useState(0)
  useHotkeys({ ...organise.shortcuts, arrowdown: () => setSelection((index) => index + 1) })
  return createElement(
    TooltipProvider,
    null,
    createElement('output', null, selection),
    createElement('input', { 'aria-label': 'Filter mail' }),
    createElement(OrganiseToolbar, {
      controls: organise.controls.filter((control) => control.id === kind),
    }),
    organise.picker &&
      createElement(OrganisePicker, {
        picker: organise.picker,
        labels: [
          {
            id: 'a:work',
            providerId: 'work',
            name: 'Work',
            accountId: 'a',
            kind: 'user',
            color: null,
          },
        ],
        onClose: () => organise.setPicker(null),
        run: mockRun,
      }),
  )
}

function button(text: string): HTMLButtonElement {
  const found = [...document.querySelectorAll('button')].find(
    (item) => item.getAttribute('aria-label') === text || item.textContent?.trim() === text,
  )
  if (!found) throw new Error(`Missing button: ${text}`)
  return found
}

async function open(control: HTMLButtonElement) {
  await act(async () => {
    control.focus()
    control.click()
  })
}

let root: ReturnType<typeof createRoot>
beforeEach(() => {
  vi.stubGlobal('IS_REACT_ACT_ENVIRONMENT', true)
  vi.stubGlobal(
    'ResizeObserver',
    class {
      observe() {}
      unobserve() {}
      disconnect() {}
    },
  )
  vi.stubGlobal('amc', { organiseErrors: async () => [], onChanged: () => () => {} })
  mockRun.mockClear().mockResolvedValue(undefined)
  const host = document.createElement('div')
  document.body.append(host)
  root = createRoot(host)
})
afterEach(async () => {
  await act(async () => root.unmount())
  document.body.replaceChildren()
  vi.useRealTimers()
  vi.unstubAllGlobals()
  vi.unstubAllEnvs()
})

it('moves the selected Thread to Trash with Backspace outside text fields', async () => {
  const organise = vi.fn(async () => 'trash-mutation')
  vi.stubGlobal('amc', { organise })
  await act(async () => root.render(createElement(Fixture, { kind: 'trash' })))
  const control = button('Move to Trash')
  const input = document.querySelector('input')
  if (!input) throw new Error('Missing filter input')
  const press = async (target: HTMLElement, key: string) => {
    const event = new KeyboardEvent('keydown', { key, bubbles: true, cancelable: true })
    await act(async () => {
      target.focus()
      target.dispatchEvent(event)
    })
    return event.defaultPrevented
  }

  expect(await press(input, 'Backspace')).toBe(false)
  expect(await press(control, '#')).toBe(false)
  expect(organise).not.toHaveBeenCalled()
  expect(await press(control, 'Backspace')).toBe(true)
  expect(organise).toHaveBeenCalledExactlyOnceWith({
    kind: 'trash',
    threadId: thread.id,
    value: true,
  })
  expect(control.getAttribute('aria-keyshortcuts')).toBe('Backspace')
})

describe('Organise picker', () => {
  it('hides the Snooze button and shortcut while Snooze is disabled', async () => {
    await act(async () =>
      root.render(createElement(Fixture, { kind: 'snooze', snoozeEnabled: false })),
    )
    expect(document.querySelector('[aria-label="Snooze"]')).toBeNull()
    await act(async () => {
      document.body.dispatchEvent(new KeyboardEvent('keydown', { key: 'h', bubbles: true }))
    })
    expect(document.querySelector('[role="dialog"]')).toBeNull()
  })
  it('keeps arrows in the Labels dialog and returns focus to the toolbar after Escape', async () => {
    await act(async () => root.render(createElement(Fixture, { kind: 'labels' })))
    const trigger = button('Labels')
    await open(trigger)
    const label = [...document.querySelectorAll('button')].find((item) =>
      item.textContent?.includes('Work'),
    )
    if (!label) throw new Error('Missing Work label')
    await act(async () => {
      label.focus()
      label.dispatchEvent(
        new KeyboardEvent('keydown', { key: 'ArrowDown', bubbles: true, cancelable: true }),
      )
    })
    expect(document.querySelector('output')?.textContent).toBe('0')
    await act(async () => {
      label.dispatchEvent(
        new KeyboardEvent('keydown', { key: 'Escape', bubbles: true, cancelable: true }),
      )
    })
    await act(async () => {
      await vi.waitFor(() => expect(document.activeElement).toBe(trigger))
    })
    expect(document.querySelector('[role="dialog"]')).toBeNull()
  })

  it('shows an existing AMC/Snoozed Label in navigation, Thread display and the picker', async () => {
    const label = {
      id: 'a:Label_existing',
      providerId: 'Label_existing',
      name: 'AMC/Snoozed',
      accountId: 'a',
      kind: 'user',
      color: null,
    } as const
    const labeledThread = { ...thread, labelIds: [label.id] }
    expect(navigableLabels([label], [])).toEqual([label])
    await act(async () =>
      root.render(
        createElement(ThreadView, {
          data: { thread: labeledThread, messages: [], drafts: [] },
          labelNames: new Map([[label.id, label.name]]),
          snoozeEnabled: false,
          scrollRef: { current: null },
        }),
      ),
    )
    expect(document.body.textContent).toContain(label.name)

    await act(async () =>
      root.render(
        createElement(OrganisePicker, {
          picker: { kind: 'labels', thread: labeledThread, trigger: null },
          labels: [label],
          onClose: () => {},
          run: mockRun,
        }),
      ),
    )
    await open(button('AMC/SnoozedRemove'))
    expect(mockRun).toHaveBeenCalledWith(
      { kind: 'label', threadId: thread.id, labelId: label.id, value: false },
      'Removed Label “AMC/Snoozed”',
    )
  })

  it('snoozes from the first Zurich 02:30 to the second when choosing In an hour', async () => {
    vi.stubEnv('TZ', 'Europe/Zurich')
    const now = Date.parse('2026-10-25T00:30:00Z')
    expect(new Date(now).getTimezoneOffset()).toBe(-120)
    expect(new Date(now + 3600_000).getTimezoneOffset()).toBe(-60)
    vi.spyOn(Date, 'now').mockReturnValue(now)
    try {
      await act(async () => root.render(createElement(Fixture, { kind: 'snooze' })))
      await open(button('Snooze'))
      await act(async () => button('In an hour').click())
      expect(document.querySelector('input[type="datetime-local"]')).toHaveProperty(
        'value',
        '2026-10-25T02:30',
      )
      const submit = document.querySelector<HTMLButtonElement>('form button[type="submit"]')
      if (!submit) throw new Error('Missing Snooze submit button')
      await act(async () => submit.click())
      expect(mockRun).toHaveBeenCalledWith(
        { kind: 'snooze', threadId: thread.id, until: now + 3600_000, noReply: false },
        'Snoozed',
      )
    } finally {
      vi.restoreAllMocks()
    }
  })
})
