// @vitest-environment jsdom

import type { ComposeDraft } from '@amc/protocol'
import { act, createElement } from 'react'
import { createRoot } from 'react-dom/client'
import { expect, it, vi } from 'vitest'
import { DraftsView } from './compose-views'
import { Composer } from './composer'

const draft: ComposeDraft = {
  id: 'draft',
  accountId: 'account',
  threadId: null,
  from: 'owner@example.test',
  to: [],
  cc: [],
  bcc: [],
  subject: 'Test draft',
  body: '',
  lastAuthor: 'owner',
  updatedAt: 0,
  revision: 1,
  update: 'AAA=',
  attachments: [],
  quote: '',
  signature: '',
  mirrorError: false,
  mirrorConflict: false,
}

it.each(['Drafts row', 'composer shortcut'])('confirms discard from the %s', async (entry) => {
  const container = document.createElement('div')
  document.body.append(container)
  const root = createRoot(container)
  const discardDraft = vi.fn().mockResolvedValue({})
  const onDiscarded = vi.fn()
  const onOpen = vi.fn()
  const onMinimise = vi.fn()
  const onQueued = vi.fn()
  vi.stubGlobal('IS_REACT_ACT_ENVIRONMENT', true)
  vi.stubGlobal('amc', {
    composeDrafts: vi.fn().mockResolvedValue([draft]),
    discardDraft,
  })

  const button = (name: string) =>
    [...document.querySelectorAll('button')].find((item) => item.textContent === name)

  try {
    await act(async () => {
      root.render(
        entry === 'Drafts row'
          ? createElement(DraftsView, { accountId: null, onOpen, onDiscarded })
          : createElement(Composer, { draft, accounts: [], onMinimise, onQueued, onDiscarded }),
      )
    })
    const openConfirmation = async () =>
      act(async () => {
        if (entry === 'Drafts row') {
          container
            .querySelector<HTMLButtonElement>('[aria-label="Discard draft: Test draft"]')
            ?.click()
        } else {
          document.querySelector('[aria-label="Message body"]')?.dispatchEvent(
            new KeyboardEvent('keydown', {
              key: 'Backspace',
              metaKey: true,
              bubbles: true,
              cancelable: true,
            }),
          )
        }
      })
    await openConfirmation()
    expect(button('Discard draft')).toBeTruthy()
    expect(discardDraft).not.toHaveBeenCalled()
    await act(async () => button('Cancel')?.click())
    expect(button('Discard draft')).toBeUndefined()
    expect(discardDraft).not.toHaveBeenCalled()
    await openConfirmation()
    await act(async () => button('Discard draft')?.click())
    expect(discardDraft).toHaveBeenCalledExactlyOnceWith(draft.id)
    expect(onDiscarded).toHaveBeenCalledOnce()
    expect(onOpen).not.toHaveBeenCalled()
    expect(onMinimise).not.toHaveBeenCalled()
    expect(onQueued).not.toHaveBeenCalled()
    expect(container.textContent).not.toContain('Test draft')
  } finally {
    await act(async () => root.unmount())
    container.remove()
    vi.unstubAllGlobals()
  }
})
