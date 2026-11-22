// @vitest-environment jsdom

import type { ComposeDraft } from '@amc/protocol'
import { act, createElement } from 'react'
import { createRoot } from 'react-dom/client'
import { toast } from 'sonner'
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

it.each(['Drafts row', 'composer button', 'composer shortcut'])(
  'confirms discard from the %s',
  async (entry) => {
    const container = document.createElement('div')
    document.body.append(container)
    const root = createRoot(container)
    const absent = entry === 'Drafts row'
    const discardDraft = vi
      .fn()
      .mockResolvedValue(absent ? { absent: draft.id } : { deleted: draft.id })
    const info = vi.spyOn(toast, 'info')
    const success = vi.spyOn(toast, 'success')
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
          } else if (entry === 'composer button') {
            document.querySelector<HTMLButtonElement>('[aria-label="Discard draft"]')?.click()
          } else {
            const trigger = document.querySelector<HTMLButtonElement>(
              '[aria-label="Discard draft"]',
            )
            trigger?.focus()
            trigger?.dispatchEvent(
              new KeyboardEvent('keydown', {
                key: 'Backspace',
                metaKey: true,
                bubbles: true,
                cancelable: true,
              }),
            )
          }
        })
      if (entry === 'composer shortcut') {
        const subject = [...document.querySelectorAll<HTMLInputElement>('input')].find(
          (input) => input.value === draft.subject,
        )
        const body = document.querySelector<HTMLElement>('[aria-label="Message body"]')
        for (const target of [subject, body]) {
          if (!target) throw new Error('Missing editable composer field')
          const key = new KeyboardEvent('keydown', {
            key: 'Backspace',
            metaKey: true,
            bubbles: true,
            cancelable: true,
          })
          await act(async () => {
            target.focus()
            target.dispatchEvent(key)
          })
          expect(key.defaultPrevented).toBe(false)
          expect(button('Discard draft')).toBeUndefined()
        }
      }
      await openConfirmation()
      expect(button('Discard draft')).toBeTruthy()
      const description = document.querySelector('[data-slot="dialog-description"]')?.textContent
      expect(description).toContain(draft.subject)
      expect(description).toContain('permanently deleted')
      expect(discardDraft).not.toHaveBeenCalled()
      await act(async () => button('Cancel')?.click())
      expect(button('Discard draft')).toBeUndefined()
      expect(discardDraft).not.toHaveBeenCalled()
      await openConfirmation()
      await act(async () => button('Discard draft')?.click())
      expect(discardDraft).toHaveBeenCalledExactlyOnceWith(draft.id)
      expect(onDiscarded).toHaveBeenCalledOnce()
      if (absent) {
        expect(info).toHaveBeenCalledWith(
          'This draft is already gone. It may have been sent or discarded elsewhere.',
        )
        expect(success).not.toHaveBeenCalled()
      } else {
        expect(success).toHaveBeenCalledWith('Draft discarded')
      }
      expect(onOpen).not.toHaveBeenCalled()
      expect(onMinimise).not.toHaveBeenCalled()
      expect(onQueued).not.toHaveBeenCalled()
      expect(container.textContent).not.toContain('Test draft')
    } finally {
      await act(async () => root.unmount())
      container.remove()
      vi.unstubAllGlobals()
      vi.restoreAllMocks()
    }
  },
)
