// @vitest-environment jsdom

import { type ComposeDraft, DRAFT_CHANGED, type OutboxItem, type SendRequest } from '@amc/protocol'
import { act, createElement } from 'react'
import { createRoot } from 'react-dom/client'
import { expect, it, vi } from 'vitest'
import { Composer } from '@/components/composer'

const draft: ComposeDraft = {
  id: 'draft',
  accountId: 'account',
  threadId: null,
  from: 'owner@example.test',
  to: [{ address: 'recipient@example.test', name: null }],
  cc: [],
  bcc: [],
  subject: 'Original subject',
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

const queued: OutboxItem = {
  id: 'send',
  draftId: draft.id,
  accountId: draft.accountId,
  messageId: 'message',
  subject: draft.subject,
  to: draft.to,
  status: 'queued',
  sendAt: 0,
  undoUntil: 0,
  detail: null,
  canResolve: false,
  threadId: null,
}

it.each(['uncertain', 'changed'])('handles a %s send response', async (kind) => {
  const container = document.createElement('div')
  document.body.append(container)
  const root = createRoot(container)
  const sendDraft = vi
    .fn<(request: SendRequest) => Promise<OutboxItem>>()
    .mockRejectedValueOnce(new Error(kind === 'uncertain' ? 'Connection lost' : DRAFT_CHANGED))
    .mockResolvedValueOnce(queued)
  const remote = { ...draft, revision: 2, subject: 'Changed remotely' }
  const composeDraft = vi.fn(async () => structuredClone(remote))
  const onQueued = vi.fn()
  vi.stubGlobal('IS_REACT_ACT_ENVIRONMENT', true)
  vi.stubGlobal('amc', { sendDraft, composeDraft, stageComposeBody: vi.fn() })
  const click = (label: string) => {
    const button = [...document.querySelectorAll('button')].find((item) =>
      item.textContent?.startsWith(label),
    )
    if (!button) throw new Error(`Missing button ${label}`)
    button.click()
  }

  try {
    await act(async () => {
      root.render(
        createElement(Composer, {
          draft,
          accounts: [],
          onMinimise: vi.fn(),
          onDiscarded: vi.fn(),
          onQueued,
        }),
      )
    })
    const editor = document.querySelector('[aria-label="Message body"]')
    expect(editor).toBeTruthy()
    await act(async () => click('Send'))
    const first = sendDraft.mock.calls[0][0]
    expect(first).toMatchObject({ draftId: draft.id, revision: 1 })
    expect(onQueued).not.toHaveBeenCalled()
    if (kind === 'uncertain') {
      expect(document.querySelector('[role="alert"]')?.textContent).toContain(
        'confirm this send again',
      )
      await act(async () => click('Confirm send'))
      expect(sendDraft.mock.calls[1][0]).toEqual(first)
      expect(composeDraft).not.toHaveBeenCalled()
    } else {
      expect(document.querySelector('[role="alert"]')?.textContent).toContain(DRAFT_CHANGED)
      expect(
        document.querySelector<HTMLInputElement>('input[value="Changed remotely"]'),
      ).toBeTruthy()
      await act(async () => click('Send'))
      expect(sendDraft.mock.calls[1][0].revision).toBe(2)
      expect(sendDraft.mock.calls[1][0].id).not.toBe(first.id)
    }
    expect(onQueued).toHaveBeenCalledExactlyOnceWith(queued, expect.any(Number))
    expect(document.querySelector('[aria-label="Message body"]')).toBe(editor)
  } finally {
    await act(async () => root.unmount())
    container.remove()
    vi.unstubAllGlobals()
  }
})
