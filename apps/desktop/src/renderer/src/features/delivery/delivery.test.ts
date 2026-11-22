// @vitest-environment jsdom

import type { OutboxItem, VersionedDraft } from '@amc/protocol'
import { act, createElement, Profiler, type ReactNode } from 'react'
import { createRoot, type Root } from 'react-dom/client'
import { afterEach, beforeEach, expect, it, vi } from 'vitest'
import { DraftsView, OutboxView } from '@/components/compose-views'

const initialTime = 100_000
const queued: OutboxItem = {
  id: 'send-1',
  accountId: 'account',
  draftId: 'draft-1',
  messageId: '<send-1@example.test>',
  subject: 'Delivery test',
  to: [{ name: 'Recipient', address: 'recipient@example.test' }],
  status: 'queued',
  sendAt: initialTime + 2000,
  undoUntil: initialTime + 2000,
  detail: null,
  canResolve: false,
  threadId: null,
}
const uncertain: OutboxItem = {
  ...queued,
  status: 'uncertain',
  detail: 'Check Sent before sending again.',
  canResolve: true,
}
const draft: VersionedDraft = {
  id: 'draft-1',
  accountId: 'account',
  threadId: null,
  from: 'owner@example.test',
  to: queued.to,
  cc: [],
  bcc: [],
  body: '',
  subject: 'Saved draft',
  lastAuthor: 'owner',
  updatedAt: initialTime,
  revision: 1,
}

let container: HTMLDivElement
let root: Root

beforeEach(() => {
  vi.useFakeTimers()
  vi.setSystemTime(initialTime)
  vi.stubGlobal('IS_REACT_ACT_ENVIRONMENT', true)
  container = document.createElement('div')
  document.body.append(container)
  root = createRoot(container)
})

afterEach(async () => {
  await act(async () => root.unmount())
  container.remove()
  vi.restoreAllMocks()
  vi.unstubAllGlobals()
  vi.useRealTimers()
})

async function mount(view: ReactNode) {
  const onRender = vi.fn()
  // biome-ignore lint/correctness/useUniqueElementIds: React Profiler names commits without creating an HTML ID.
  const profiledView = createElement(Profiler, { id: 'delivery', onRender }, view)
  await act(async () => root.render(profiledView))
  onRender.mockClear()
  return onRender
}

async function advance(ms: number) {
  await act(async () => vi.advanceTimersByTimeAsync(ms))
}

function button(text: string) {
  return [...document.querySelectorAll('button')].find((entry) => entry.textContent === text)
}

async function click(text: string) {
  const target = button(text)
  if (!target) throw new Error(`Missing button: ${text}`)
  await act(async () => target.click())
}

async function mountOutbox(item: OutboxItem) {
  let current = item
  const outbox = vi.fn(async () => [
    structuredClone({
      ...current,
      undoRemainingMs: Math.max(0, current.undoUntil - Date.now()),
    }),
  ])
  const cancelSend = vi.fn(async () => {
    current = { ...current, status: 'cancelled' }
  })
  const resolveSend = vi.fn(async (_id: string, action: 'check' | 'reopen') => {
    current = {
      ...current,
      canResolve: false,
      status: action === 'check' ? 'dispatching' : 'uncertain',
      detail: action === 'reopen' ? 'The owner reopened the draft.' : null,
    }
    return { draftId: 'restored-draft' }
  })
  vi.stubGlobal('amc', { outbox, cancelSend, resolveSend })
  const onRestore = vi.fn()
  const onThread = vi.fn()
  const commits = await mount(
    createElement(OutboxView, { accountId: null, onRestore, onThread, onSettings: vi.fn() }),
  )
  const row = container.querySelector('article')
  expect(row?.textContent).toContain(current.subject)
  return {
    commits,
    row,
    outbox,
    cancelSend,
    resolveSend,
    onRestore,
    onThread,
    setItem: (next: OutboxItem) => {
      current = next
    },
  }
}

it('keeps queued rows stable and expires cancellation during failed polls', async () => {
  const { commits, row, outbox, cancelSend, setItem } = await mountOutbox(queued)
  const cancel = button('Cancel send')
  expect(cancel).toBeDefined()
  expect(row?.textContent).toContain('Scheduled')

  await advance(750)
  expect(outbox).toHaveBeenCalledTimes(2)
  expect(commits).not.toHaveBeenCalled()
  expect(button('Cancel send')).toBe(cancel)

  outbox.mockRejectedValueOnce(new Error('Engine unavailable'))
  await advance(750)
  expect(container.querySelector('[role="alert"]')?.textContent).toContain('Engine unavailable')
  expect(container.querySelector('article')).toBe(row)
  expect(button('Cancel send')).toBe(cancel)

  await advance(500)
  expect(outbox).toHaveBeenCalledTimes(3)
  expect(row?.textContent).toContain('Waiting for delivery')
  expect(button('Cancel send')).toBeUndefined()
  expect(button('Undo')).toBeUndefined()
  expect(cancelSend).not.toHaveBeenCalled()

  await advance(250)
  expect(container.querySelector('[role="alert"]')?.textContent).toBe('')
  expect(row?.textContent).toContain('Waiting for delivery')
  expect(button('Cancel send')).toBeUndefined()

  setItem({ ...queued, status: 'sent' })
  await advance(750)
  expect(row?.textContent).toContain('Sent')
  expect(button('Cancel send')).toBeUndefined()
  expect(button('Undo')).toBeUndefined()
})

it('keeps uncertain and resolved rows mounted through equal and failed polls', async () => {
  const { commits, row, outbox, resolveSend, onThread, setItem } = await mountOutbox(uncertain)
  expect(row?.textContent).toContain(uncertain.messageId)
  expect(button('Cancel send')).toBeUndefined()
  await advance(750)
  expect(commits).not.toHaveBeenCalled()
  outbox.mockRejectedValueOnce(new Error('Engine unavailable'))
  await advance(750)
  expect(container.querySelector('article')).toBe(row)
  await click('Check Sent again')
  expect(resolveSend).toHaveBeenCalledExactlyOnceWith(uncertain.id, 'check')

  await advance(750)
  expect(row?.textContent).toContain('Checking delivery')
  expect(button('Reopen draft…')).toBeUndefined()

  setItem({ ...uncertain, status: 'sent', canResolve: false, threadId: 'thread-1', detail: null })
  await advance(750)
  const viewThread = button('View Thread')
  expect(viewThread).toBeDefined()
  commits.mockClear()
  await advance(750)
  expect(commits).not.toHaveBeenCalled()
  outbox.mockRejectedValueOnce(new Error('Engine unavailable'))
  await advance(750)
  expect(container.querySelector('article')).toBe(row)
  expect(button('View Thread')).toBe(viewThread)
  expect(button('Undo')).toBeUndefined()
  await click('View Thread')
  expect(onThread).toHaveBeenCalledExactlyOnceWith('thread-1')
})

it('confirms reopening an uncertain send across polled refreshes', async () => {
  const { commits, row, outbox, resolveSend, onRestore } = await mountOutbox(uncertain)
  await click('Reopen draft…')
  const confirmation = button('Reopen draft')
  expect(confirmation).toBeDefined()
  expect(resolveSend).not.toHaveBeenCalled()

  await advance(750)
  outbox.mockRejectedValueOnce(new Error('Engine unavailable'))
  await advance(750)
  expect(button('Reopen draft')).toBe(confirmation)
  await click('Reopen draft')
  expect(resolveSend).toHaveBeenCalledExactlyOnceWith(uncertain.id, 'reopen')
  expect(onRestore).toHaveBeenCalledExactlyOnceWith('restored-draft')
  expect(button('Reopen draft…')).toBeUndefined()

  await advance(750)
  expect(row?.textContent).toContain('The owner reopened the draft.')
  commits.mockClear()
  await advance(750)
  expect(commits).not.toHaveBeenCalled()
  outbox.mockRejectedValueOnce(new Error('Engine unavailable'))
  await advance(750)
  expect(container.querySelector('article')).toBe(row)
  expect(row?.textContent).toContain('The owner reopened the draft.')
  expect(button('Reopen draft…')).toBeUndefined()
  expect(button('Undo')).toBeUndefined()
})

it('cancels a future scheduled send and restores its draft', async () => {
  const { cancelSend, onRestore, row } = await mountOutbox({
    ...queued,
    sendAt: queued.undoUntil + 1500,
  })
  await advance(2250)
  expect(button('Cancel and reopen to reschedule')).toBeDefined()
  await click('Cancel and reopen to reschedule')
  expect(cancelSend).toHaveBeenCalledExactlyOnceWith(queued.id)
  expect(onRestore).toHaveBeenCalledExactlyOnceWith(queued.draftId)
  await advance(750)
  expect(row?.textContent).toContain('Cancelled')
  expect(button('Cancel and reopen to reschedule')).toBeUndefined()
})

it('retains focused draft rows and skips commits for equal replies and repeated failures', async () => {
  let drafts = [draft, { ...draft, id: 'draft-2', subject: 'Second draft' }]
  const composeDrafts = vi.fn(async () => structuredClone(drafts))
  const formatDate = vi.spyOn(Date.prototype, 'toLocaleDateString')
  vi.stubGlobal('amc', { composeDrafts })
  const onOpen = vi.fn()
  const commits = await mount(
    createElement(DraftsView, { accountId: null, onOpen, onDiscarded: vi.fn() }),
  )
  const open = container.querySelector('button')
  expect(open?.textContent).toContain(draft.subject)
  open?.focus()

  await advance(1500)
  expect(composeDrafts).toHaveBeenCalledTimes(2)
  expect(commits).not.toHaveBeenCalled()
  composeDrafts.mockRejectedValueOnce(new Error('Drafts unavailable'))
  composeDrafts.mockRejectedValueOnce(new Error('Drafts unavailable'))
  await advance(1500)
  const alert = container.querySelector('[role="alert"]')
  expect(alert?.textContent).toContain('Drafts unavailable')
  expect(commits).toHaveBeenCalledTimes(1)

  commits.mockClear()
  await advance(1500)
  expect(commits).not.toHaveBeenCalled()
  expect(document.activeElement).toBe(open)
  expect(container.querySelector('button')).toBe(open)

  await advance(1500)
  expect(alert?.textContent).toBe('')
  expect(document.activeElement).toBe(open)
  await act(async () => open?.click())
  expect(onOpen).toHaveBeenCalledExactlyOnceWith(draft.id)

  formatDate.mockClear()
  drafts = [draft, { ...drafts[1], subject: 'Edited draft' }]
  await advance(1500)
  expect(container.textContent).toContain('Edited draft')
  expect(formatDate).toHaveBeenCalledTimes(1)
  expect(document.activeElement).toBe(open)
})

it('waits for a slow poll and recovers from an initial failure without a false empty result', async () => {
  let rejectSlow!: (reason: Error) => void
  const slow = new Promise<VersionedDraft[]>((_, reject) => {
    rejectSlow = reject
  })
  const composeDrafts = vi
    .fn(async (): Promise<VersionedDraft[]> => [])
    .mockReturnValueOnce(slow)
    .mockRejectedValueOnce(new Error('Drafts unavailable'))
  vi.stubGlobal('amc', { composeDrafts })
  await mount(createElement(DraftsView, { accountId: null, onOpen: vi.fn(), onDiscarded: vi.fn() }))

  await advance(4500)
  expect(composeDrafts).toHaveBeenCalledOnce()
  expect(container.textContent).toContain('Loading drafts')
  await act(async () => rejectSlow(new Error('Drafts unavailable')))
  expect(container.textContent).toContain('Drafts unavailable')
  expect(container.textContent).not.toContain('No saved drafts')
  await advance(1500)
  expect(container.textContent).toContain('Drafts unavailable')
  expect(container.textContent).not.toContain('No saved drafts')
  await advance(1500)
  expect(container.textContent).toContain('No saved drafts')
  expect(container.textContent).not.toContain('Drafts unavailable')
})
