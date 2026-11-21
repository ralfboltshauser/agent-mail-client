// @vitest-environment jsdom

import type { OrganiseAction, ThreadSummary } from '@amc/protocol'
import { act, createElement, useState } from 'react'
import { createRoot } from 'react-dom/client'
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import { useHotkeys } from '../hooks/use-hotkeys'
import { OrganisePicker, OrganiseToolbar, useOrganise } from './organise'
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

function Fixture({ kind }: { kind: 'labels' | 'snooze' }) {
  const organise = useOrganise(thread)
  const [selection, setSelection] = useState(0)
  useHotkeys({ arrowdown: () => setSelection((index) => index + 1) })
  return createElement(
    TooltipProvider,
    null,
    createElement('output', null, selection),
    createElement(OrganiseToolbar, {
      controls: organise.controls.filter((control) => control.name.toLowerCase() === kind),
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

describe('Organise picker', () => {
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
