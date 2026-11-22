import type { OwnerActionStatus, TriageQueuePage } from '@amc/protocol'
import { act, cleanup, fireEvent, screen, within } from '@testing-library/react'
import { expect, it, vi } from 'vitest'
import type { SmartInboxApi } from '../../apps/desktop/src/shared/api'
import { deferred, rendererAdapter } from './adapter'
import { commits, expectBudget } from './profile'
import { firstSubject, listbox, mount, row } from './workspace'

type Card = TriageQueuePage['cards'][number]

async function fixture({ empty = false } = {}) {
  const adapter = rendererAdapter()
  const details = await Promise.all(['thread-1', 'thread-2', 'thread-3'].map(adapter.api.thread))
  const cards = details.map((detail, index): Card => {
    if (!detail) throw new Error('Expected synthetic Thread')
    const message = detail.messages.at(-1)
    if (!message?.from) throw new Error('Expected synthetic Sender')
    const { accountId, id: threadId } = detail.thread
    return {
      id:
        index < 2
          ? { kind: 'sender', accountId, address: 'mina.park@example.test' }
          : { kind: 'thread', threadId },
      accountId,
      threadId,
      messageId: message.id,
      revision: 1,
      threadRevision: 42,
      reason: index < 2 ? 'New sender' : 'Could be Action or Update',
    }
  })
  const [first, representative, low] = cards
  let available = empty ? [] : cards
  const ledger = new Map<string, OwnerActionStatus>()
  const result = (id: string, status: OwnerActionStatus['status'] = 'applied') => ({
    actionId: id,
    accountId: 'studio',
    kind: 'fixture',
    status,
    error: null,
    mutationIds: [],
  })
  const sameId = (left: Card, right: Card) => JSON.stringify(left.id) === JSON.stringify(right.id)
  const smart = {
    reviewPairing: vi.fn(async () => 'fixture-pairing'),
    triageQueue: vi.fn<SmartInboxApi['triageQueue']>(async (query) => {
      const omit = JSON.parse(query.omitThreads ?? '[]') as string[]
      const matches = available.filter(
        (card) =>
          (!query.accountId || query.accountId === card.accountId) &&
          (!query.threadId || query.threadId === card.threadId) &&
          (!query.senderAddress ||
            (card.id.kind === 'sender' && query.senderAddress === card.id.address)) &&
          !omit.includes(card.threadId),
      )
      return {
        reviewLookup: true,
        revision: 10,
        cards: matches.filter(
          (card, index) => matches.findIndex((other) => sameId(card, other)) === index,
        ),
        cursor: null,
      }
    }),
    decideSender: vi.fn<SmartInboxApi['decideSender']>(async (input) => {
      const status = result(input.clientActionId)
      ledger.set(input.clientActionId, status)
      available = available.filter((card) => card.id.kind !== 'sender')
      return status
    }),
    reviewBucket: vi.fn<SmartInboxApi['reviewBucket']>(async (input) => {
      const status = result(input.clientActionId)
      ledger.set(input.clientActionId, status)
      if (input.threadId === low.threadId) available = available.filter((card) => card !== low)
      return status
    }),
    reviewOrganise: vi.fn<SmartInboxApi['reviewOrganise']>(async (_input, id) => id),
    reviewOrganiseStatus: vi.fn<SmartInboxApi['reviewOrganiseStatus']>(async () => ({
      status: 'applied',
      error: null,
    })),
    ownerAction: vi.fn<SmartInboxApi['ownerAction']>(async (id) => ledger.get(id) ?? result(id)),
    undoOwnerAction: vi.fn<SmartInboxApi['undoOwnerAction']>(async (id) => {
      available = cards
      const status = result(id)
      return { ...status, undo: { status: 'applied', error: null, mutationIds: [] } }
    }),
    listSenders: vi.fn(async () => ({ rows: [], cursor: null })),
    adoptScreenedDestination: vi.fn(async () => ({ accountId: 'studio', providerId: 'screened' })),
    resolveSenderAvatars: vi.fn(async () => ({ rows: [] })),
  } satisfies SmartInboxApi
  Object.assign(adapter.api, { smartInbox: smart })
  return {
    adapter,
    smart,
    first,
    representative,
    low,
    removeSender: () => {
      available = [low]
    },
    result,
  }
}

const tick = async (ms = 0) => {
  await act(async () => {
    await vi.advanceTimersByTimeAsync(ms)
  })
}
const review = () => screen.getByRole('dialog', { name: 'Triage Inbox' })
const progress = () => within(review()).getByLabelText('Triage progress').textContent
const open = async () => {
  await press('t', listbox())
  await tick()
}
async function press(key: string, target = document.activeElement ?? document.body, options = {}) {
  await act(async () => {
    fireEvent.keyDown(target, { key, ...options })
  })
}
async function click(element: Element) {
  await act(async () => {
    fireEvent.click(element)
  })
}

it('keeps one card, isolates cursor commits, and resumes through exit and restart', async () => {
  const { adapter } = await fixture()
  await mount(adapter)
  const initial = listbox()
  initial.focus()
  await open()
  expect(progress()).toBe('1/2')
  expect(within(review()).getByRole('heading', { name: firstSubject })).toBeTruthy()
  expect(document.activeElement).toBe(
    within(review()).getByRole('heading', { name: 'Triage Inbox' }),
  )
  await press(' ', within(review()).getByRole('button', { name: /^Archive/ }))
  expect(progress()).toBe('1/2')
  commits.clear()
  await press(' ')
  expect(progress()).toBe('2/2')
  expect(within(review()).getAllByRole('article')).toHaveLength(1)
  expect(commits.get('ReviewCard')).toBe(1)
  expect(commits.get('ReviewProgress')).toBe(1)
  expectBudget({
    workspace: 0,
    sidebar: 0,
    list: 0,
    reader: 0,
    composer: 0,
    rows: 0,
    reviewCard: 1,
    reviewProgress: 1,
  })
  await press('Escape')
  await tick()
  expect(document.activeElement).toBe(initial)
  expect(listbox()).toBe(initial)
  cleanup()
  await mount(adapter)
  await open()
  expect(progress()).toBe('2/2')
  await press('u')
  expect(progress()).toBe('1/2')
})

it('retries a failed read and waits for an authoritative empty batch', async () => {
  const { adapter, smart } = await fixture({ empty: true })
  const pending = deferred<TriageQueuePage>()
  smart.triageQueue.mockImplementationOnce(() => pending.promise)
  await mount(adapter)
  await open()
  expect(within(review()).getByText('Loading triage queue…')).toBeTruthy()
  expect(within(review()).queryByText('All clear')).toBeNull()
  await act(async () =>
    pending.resolve({ reviewLookup: true, cards: [], revision: 10, cursor: null }),
  )
  expect(within(review()).getByText('All clear')).toBeTruthy()
  smart.triageQueue.mockRejectedValueOnce(new Error('Offline'))
  await click(within(review()).getByRole('button', { name: 'Check for new cards' }))
  expect(within(review()).getByRole('alert').textContent).toBe('Offline')
  await click(within(review()).getByRole('button', { name: 'Retry' }))
  expect(smart.triageQueue).toHaveBeenCalledTimes(3)
  expect(within(review()).getByText('All clear')).toBeTruthy()
})

it('keeps a grouped sender at the same position after a representative Bucket correction', async () => {
  const { adapter, smart, first, representative } = await fixture()
  await mount(adapter)
  await open()
  await press('2')
  expect(smart.reviewBucket).toHaveBeenCalledWith(
    expect.objectContaining({
      threadId: first.threadId,
      intent: 'review',
      expectedRevision: 42,
      bucket: 'Action',
    }),
  )
  expect(progress()).toBe('1/2')
  expect(within(review()).getByRole('heading', { name: 'Sunday at the studio' })).toBeTruthy()
  await press('u')
  expect(smart.undoOwnerAction).toHaveBeenCalledWith(
    smart.reviewBucket.mock.calls[0][0].clientActionId,
  )
  expect(within(review()).getByRole('heading', { name: firstSubject })).toBeTruthy()
  await press('1', document.activeElement ?? review(), { repeat: true })
  expect(smart.reviewBucket).toHaveBeenCalledTimes(1)
  expect(smart.triageQueue).toHaveBeenCalledWith(
    expect.objectContaining({
      omitThreads: JSON.stringify([first.threadId]),
    }),
  )
  expect(representative.threadId).not.toBe(first.threadId)
})

it('keeps the old card on a stale write and refreshes to the next eligible card', async () => {
  const { adapter, removeSender, smart } = await fixture()
  await mount(adapter)
  await open()
  removeSender()
  await press('a')
  expect(smart.decideSender).not.toHaveBeenCalled()
  expect(within(review()).getByRole('alert').textContent).toContain('This card changed')
  expect(within(review()).getByRole('heading', { name: firstSubject })).toBeTruthy()
  await click(within(review()).getByRole('button', { name: 'Retry' }))
  expect(progress()).toBe('2/2')
})

it('retries a dropped decision acknowledgment with the same id and surfaces partial Block after exit', async () => {
  const { adapter, smart, result } = await fixture()
  smart.decideSender.mockRejectedValueOnce(new Error('Connection dropped'))
  await mount(adapter)
  await open()
  await press('x')
  const block = screen.getByRole('dialog', { name: 'Block mina.park@example.test?' })
  await press('a', within(block).getByRole('button', { name: 'Cancel' }))
  expect(smart.decideSender).not.toHaveBeenCalled()
  await click(within(block).getByRole('button', { name: 'Block sender' }))
  expect(smart.decideSender).toHaveBeenCalledTimes(1)
  expect(progress()).toBe('1/2')
  const id = smart.decideSender.mock.calls[0][0].clientActionId
  smart.decideSender.mockResolvedValueOnce(result(id, 'pending'))
  await click(within(review()).getByText('Action history (1)'))
  await click(within(review()).getByRole('button', { name: 'Retry decision' }))
  expect(smart.decideSender.mock.calls[1][0].clientActionId).toBe(id)
  expect(progress()).toBe('2/2')
  await press('Escape', within(review()).getByRole('heading', { name: 'Triage Inbox' }))
  smart.ownerAction.mockResolvedValueOnce({
    ...result(id, 'partial'),
    error: 'One message remained in Inbox',
  })
  await tick(2000)
  await open()
  await click(within(review()).getByText('Action history (1)'))
  expect(within(review()).getByText('One message remained in Inbox')).toBeTruthy()
  await click(within(review()).getAllByRole('button', { name: /^Undo/ }).at(-1)!)
  expect(smart.undoOwnerAction).toHaveBeenCalledWith(id)
})

it('opens the real reply composer, leaves a draft, and returns to the same card', async () => {
  const { adapter } = await fixture()
  await mount(adapter)
  await open()
  await press('r')
  const dialog = screen.getByRole('dialog', { name: 'Compose' })
  expect(adapter.api.startCompose).toHaveBeenCalledWith({
    mode: 'reply',
    accountId: 'studio',
    threadId: 'thread-1',
  })
  await press('a', dialog)
  expect(adapter.api.startCompose).toHaveBeenCalledTimes(1)
  await click(within(dialog).getByRole('button', { name: /minimi[sz]e/i }))
  await tick()
  expect(progress()).toBe('1/2')
  expect(within(review()).getByRole('heading', { name: firstSubject })).toBeTruthy()
})

it('uses the Inbox heading when a review invoker is no longer mounted', async () => {
  const { adapter } = await fixture()
  await mount(adapter)
  const invoker = row(firstSubject)
  await press('t', invoker)
  await tick()
  await press('Escape')
  await tick()
  expect(screen.getByRole('heading', { name: 'Inbox', level: 2 }).isConnected).toBe(true)
})
