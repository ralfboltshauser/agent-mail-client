import { act, cleanup, fireEvent, screen, waitFor, within } from '@testing-library/react'
import { afterEach, expect, it, vi } from 'vitest'
import type { ReviewApi, SmartInboxApi } from '../../apps/desktop/src/shared/api'
import { deferred, rendererAdapter } from './adapter'
import { commits, expectBudget } from './profile'
import { firstSubject, listbox, mount, reader, row } from './workspace'

afterEach(() => vi.unstubAllEnvs())

type TriageQueuePage = Awaited<ReturnType<SmartInboxApi['triageQueue']>>
type OwnerActionStatus = Awaited<ReturnType<SmartInboxApi['ownerAction']>>
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
      ...(index === 2 ? { suggestFilter: true } : {}),
    }
  })
  const [first, representative, low] = cards
  let available = empty ? [] : cards
  let revision = 10
  const ledger = new Map<string, OwnerActionStatus>()
  const result = (id: string, status: OwnerActionStatus['status'] = 'applied') => ({
    actionId: id,
    accountId: 'studio',
    kind: 'fixture',
    status,
    error: null,
    mutationIds: [],
    undo: null,
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
        revision,
        cards: matches.filter(
          (card, index) => matches.findIndex((other) => sameId(card, other)) === index,
        ),
        cursor: null,
      }
    }),
    decideSender: vi.fn<SmartInboxApi['decideSender']>(async (input) => {
      const status = {
        ...result(input.clientActionId),
        ...(input.reason ? { ownerReason: input.reason, reasonRevision: 'revision-1' } : {}),
      }
      ledger.set(input.clientActionId, status)
      available = available.filter((card) => card.id.kind !== 'sender')
      return status
    }),
    reviewFilter: vi.fn<NonNullable<SmartInboxApi['reviewFilter']>>(async (input) => {
      const status = {
        ...result(input.clientActionId),
        ...(input.reason ? { ownerReason: input.reason, reasonRevision: 'revision-1' } : {}),
      }
      ledger.set(input.clientActionId, status)
      available = available.filter((card) => card.threadId !== input.threadId)
      return status
    }),
    editOwnerReason: vi.fn<NonNullable<SmartInboxApi['editOwnerReason']>>(
      async (_id, { reason }) => ({
        reason,
        reasonRevision: 'revision-2',
      }),
    ),
    reviewBucket: vi.fn<ReviewApi['reviewBucket']>(async (input) => {
      const status = result(input.clientActionId)
      ledger.set(input.clientActionId, status)
      if (input.threadId === low.threadId) available = available.filter((card) => card !== low)
      return status
    }),
    reviewOrganise: vi.fn<ReviewApi['reviewOrganise']>(async (_input, id) => id),
    reviewOrganiseStatus: vi.fn<ReviewApi['reviewOrganiseStatus']>(async () => ({
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
  } satisfies SmartInboxApi & ReviewApi
  Object.assign(adapter.api, { smartInbox: { ...smart, review: smart } })
  return {
    adapter,
    smart,
    first,
    representative,
    low,
    setCards: (...next: Card[]) => {
      available = next
      revision++
    },
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

it('opens Settings from the native menu and returns to the same triage card', async () => {
  const { adapter } = await fixture()
  await mount(adapter)
  await open()
  const heading = within(review()).getByRole('heading', { name: firstSubject })
  const focus = document.activeElement

  await act(async () => adapter.emitOpenSettings())
  const settings = screen.getByRole('dialog', { name: 'Settings' })
  expect(settings.contains(document.activeElement)).toBe(true)
  await press('Escape')
  await tick()

  expect(screen.queryByRole('dialog', { name: 'Settings' })).toBeNull()
  expect(within(review()).getByRole('heading', { name: firstSubject })).toBe(heading)
  expect(document.activeElement).toBe(focus)
})

it('keeps the same triage card and focus when Escape closes feedback', async () => {
  const { adapter } = await fixture()
  await mount(adapter)
  await open()
  const heading = within(review()).getByRole('heading', { name: firstSubject })
  const focus = document.activeElement

  vi.useRealTimers()
  await act(async () => adapter.emitFeedback())
  await waitFor(() => expect(review().querySelector('agentation-toolbar')).toBeTruthy())
  await press('Escape')

  expect(review().querySelector('agentation-toolbar')).toBeNull()
  expect(within(review()).getByRole('heading', { name: firstSubject })).toBe(heading)
  expect(document.activeElement).toBe(focus)
})

it('keeps one card, isolates cursor commits, and clears skips on exit and restart', async () => {
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
  initial.focus()
  expect(review().contains(document.activeElement)).toBe(true)
  expect(within(review()).queryByText('Loading triage queue…')).toBeNull()
  expect(review().querySelector('[aria-live="polite"]')).toBeTruthy()
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
  expect(progress()).toBe('1/2')
  expect(within(review()).getByRole('heading', { name: firstSubject })).toBeTruthy()
  expect(within(review()).getByText('Action history (1)')).toBeTruthy()
  await press('u')
  expect(progress()).toBe('1/2')
})

it('checks the live queue at the end and retries a failed refresh before showing All clear', async () => {
  const { adapter, smart, low, setCards } = await fixture()
  await mount(adapter)
  await open()
  await press('a')
  const staleEnd = deferred<TriageQueuePage>()
  smart.triageQueue.mockImplementationOnce(async (query) => {
    expect(query).toEqual({ accountId: undefined, limit: 100 })
    return staleEnd.promise
  })
  setCards()
  await press(' ')
  expect(within(review()).getByText('Checking review…')).toBeTruthy()
  expect(within(review()).queryByText('All clear')).toBeNull()

  // A revision arrives while the empty response is in flight.
  setCards(low)
  smart.triageQueue.mockRejectedValueOnce(new Error('Offline'))
  await act(async () => adapter.emitChanged())
  await act(async () =>
    staleEnd.resolve({ reviewLookup: true, cards: [], revision: 11, cursor: null }),
  )
  expect(within(review()).getByRole('alert').textContent).toBe('Offline')
  expect(within(review()).queryByText('All clear')).toBeNull()
  await click(within(review()).getByRole('button', { name: 'Retry' }))
  expect(within(review()).getByText('1 skipped')).toBeTruthy()

  // Once the skipped card leaves the Engine queue, the live check can show All clear.
  setCards()
  await act(async () => adapter.emitChanged())
  expect(within(review()).getByText('All clear')).toBeTruthy()
})

it.each([false, true])(
  'opens a fresh queue after a saved All clear (restart: %s)',
  async (restart) => {
    const { adapter, smart, first, low, setCards } = await fixture()
    setCards(first)
    await mount(adapter)
    await open()
    await press('a')
    expect(within(review()).getByText('All clear')).toBeTruthy()
    await press('Escape')
    await tick()
    if (restart) {
      cleanup()
      await mount(adapter)
    }

    // Neither the persisted review nor the replica has received a queue change event.
    setCards(first, low)
    const queue = smart.triageQueue.getMockImplementation()
    if (!queue) throw new Error('Expected synthetic queue')
    const live = await queue({ limit: 100 })
    const pending = deferred<TriageQueuePage>()
    smart.triageQueue.mockClear().mockImplementationOnce(() => pending.promise)
    await open()
    expect(smart.triageQueue).toHaveBeenCalledExactlyOnceWith({
      accountId: undefined,
      limit: 100,
    })
    expect(within(review()).queryByText('All clear')).toBeNull()
    expect(within(review()).getByText('Loading triage queue…')).toBeTruthy()
    await act(async () => pending.resolve(live))
    expect(progress()).toBe('1/2')
    expect(within(review()).getByRole('heading', { name: firstSubject })).toBeTruthy()
    await press(' ')
    expect(progress()).toBe('2/2')
    expect(
      within(review()).getByRole('heading', { name: 'Invoice for the spring issue' }),
    ).toBeTruthy()
  },
)

it('guards an unconfirmed decision when fresh entry gives its card a new position', async () => {
  const { adapter, first, low, setCards, smart } = await fixture()
  smart.decideSender.mockRejectedValueOnce(new Error('Connection dropped'))
  await mount(adapter)
  await open()
  await press('a')
  expect(smart.decideSender).toHaveBeenCalledTimes(1)
  await press('Escape')
  await tick()

  setCards(low, first)
  await open()
  await press(' ')
  expect(within(review()).getByRole('heading', { name: firstSubject })).toBeTruthy()
  await press('a')
  expect(smart.decideSender).toHaveBeenCalledTimes(1)
  expect(
    within(review()).getByText(/Retry the unconfirmed decision from action history/),
  ).toBeTruthy()
})

it('opens new cards found at the end even without a replica event', async () => {
  const { adapter, first, low, setCards } = await fixture()
  setCards(first)
  await mount(adapter)
  await open()
  setCards(low, first)
  await press('a')
  expect(progress()).toBe('2/2')
  expect(
    within(review()).getByRole('heading', { name: 'Invoice for the spring issue' }),
  ).toBeTruthy()
  expect(within(review()).queryByText('All clear')).toBeNull()
  await press('2')
  expect(within(review()).getByText('All clear')).toBeTruthy()
})

it('appends newly eligible cards without moving focus or committing the open card', async () => {
  const { adapter, first, low, setCards, smart } = await fixture()
  setCards(first)
  await mount(adapter)
  await open()
  const article = within(review()).getByRole('article')
  const focus = within(article).getByRole('button', { name: /^Filter out/ })
  focus.focus()
  const queue = smart.triageQueue.getMockImplementation()
  if (!queue) throw new Error('Expected synthetic queue')
  const previous = await queue({ limit: 100 })
  const pending = deferred<TriageQueuePage>()
  smart.triageQueue.mockImplementationOnce(() => pending.promise)
  commits.clear()
  await act(async () => adapter.emitChanged())
  expect(progress()).toBe('1/1')
  expect(within(review()).queryByText('Checking review…')).toBeNull()
  setCards(low, first)
  await act(async () => adapter.emitChanged())
  await act(async () => pending.resolve(previous))

  expect(progress()).toBe('1/2')
  expect(within(review()).getByRole('article')).toBe(article)
  expect(document.activeElement).toBe(focus)
  expectBudget({ workspace: 0, list: 0, reader: 0, reviewCard: 0, reviewProgress: 1 })
  commits.clear()
  await act(async () => adapter.emitChanged())
  expectBudget({ workspace: 0, list: 0, reader: 0, reviewCard: 0, reviewProgress: 0 })
  await press(' ', within(review()).getByRole('heading', { name: 'Triage Inbox' }))
  expect(progress()).toBe('2/2')
  expect(
    within(review()).getByRole('heading', { name: 'Invoice for the spring issue' }),
  ).toBeTruthy()
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
  await click(within(review()).getByRole('button', { name: /^Undo$/ }))
  expect(smart.undoOwnerAction).toHaveBeenCalledWith(id)
})

it('opens the real reply composer, leaves a draft, and returns to the same card', async () => {
  const { adapter, smart } = await fixture()
  await mount(adapter)
  await open()
  await press('r')
  const dialog = screen.getByRole('dialog', { name: 'Compose' })
  expect(adapter.api.startCompose).toHaveBeenCalledWith({
    mode: 'reply',
    accountId: 'studio',
    threadId: 'thread-1',
  })
  const subject = within(dialog).getByRole('textbox', { name: 'Subject' })
  const editor = within(dialog).getByRole('textbox', { name: 'Message body' })
  await press('t', subject)
  await press('x', editor)
  await press('a', dialog)
  expect(smart.decideSender).not.toHaveBeenCalled()
  expect(screen.queryByRole('dialog', { name: /Block/ })).toBeNull()
  expect(screen.queryByRole('dialog', { name: 'Triage Inbox' })).toBeNull()
  expect(adapter.api.startCompose).toHaveBeenCalledTimes(1)
  await click(within(dialog).getByRole('button', { name: /minimi[sz]e/i }))
  await tick()
  expect(progress()).toBe('1/2')
  expect(within(review()).getByRole('heading', { name: firstSubject })).toBeTruthy()
})

it('uses the Inbox heading when review starts without a focused control', async () => {
  const { adapter } = await fixture()
  await mount(adapter)
  await press('t', document.body)
  await tick()
  await press('Escape')
  await tick()
  expect(document.activeElement).toBe(screen.getByRole('heading', { name: 'Inbox', level: 2 }))
})

it('uses the Snooze picker and exact Organise Undo for the representative Thread', async () => {
  const { adapter, smart, first } = await fixture()
  await mount(adapter)
  await open()
  await press('s')
  const picker = screen.getByRole('dialog', { name: 'Snooze Thread' })
  await press('e', within(picker).getByLabelText('Return to Inbox'))
  expect(smart.reviewOrganise).not.toHaveBeenCalled()
  await click(within(picker).getByRole('button', { name: 'Snooze' }))
  await tick()
  const [input, id, messageId] = smart.reviewOrganise.mock.calls[0]
  expect(input).toMatchObject({ kind: 'snooze', threadId: first.threadId })
  expect(messageId).toBe(first.messageId)
  expect(progress()).toBe('1/2')
  await press('u')
  expect(smart.reviewOrganise.mock.calls[1][0]).toEqual({
    kind: 'undo',
    threadId: first.threadId,
    mutationId: id,
  })
  await tick(2000)
  expect(within(review()).getByRole('heading', { name: firstSubject })).toBeTruthy()
})

it('preserves scope and notification navigation when an older queue load finishes late', async () => {
  const { adapter, smart } = await fixture()
  const target = (await adapter.api.thread('thread-3'))?.thread
  if (!target) throw new Error('Expected notification Thread')
  let notify: ((thread: NonNullable<typeof target>) => void) | undefined
  adapter.api.onOpenThread = (callback) => {
    notify = callback
    return () => {
      notify = undefined
    }
  }
  const previous = deferred<TriageQueuePage>()
  smart.triageQueue.mockImplementationOnce(() => previous.promise)
  await mount(adapter)
  await open()
  expect(within(review()).getByText('Loading triage queue…')).toBeTruthy()
  await act(async () => {
    notify?.(target)
  })
  expect(screen.queryByRole('dialog', { name: 'Triage Inbox' })).toBeNull()
  expect(row(target.subject).getAttribute('aria-selected')).toBe('true')
  await press('1', listbox(), { metaKey: true })
  await open()
  expect(smart.triageQueue).toHaveBeenCalledWith({ accountId: 'studio', limit: 100 })
  expect(progress()).toBe('1/2')
  await act(async () =>
    previous.resolve({ reviewLookup: true, cards: [], cursor: null, revision: 8 }),
  )
  expect(progress()).toBe('1/2')
  await press('Escape')
  await tick()
  await press('0', listbox(), { metaKey: true })
  await open()
  expect(smart.triageQueue.mock.calls.filter(([query]) => query.limit === 100)).toHaveLength(3)
})

it('keeps ordinary Shift+T, Inbox T, and sequence G then T distinct', async () => {
  const { adapter, smart } = await fixture()
  await mount(adapter)
  await press('T', listbox(), { shiftKey: true })
  await tick()
  const handoff = screen.getByRole('dialog', { name: /Hand off/i })
  expect(smart.triageQueue).not.toHaveBeenCalled()
  await press('Escape', handoff)
  await tick()
  await press('g', listbox())
  await press('t', listbox())
  expect(screen.queryByRole('dialog', { name: 'Triage Inbox' })).toBeNull()
  expect(screen.getByRole('heading', { name: 'Sent', level: 2 })).toBeTruthy()
  await press('g', document.body)
  await press('i', document.body)
  await open()
  expect(progress()).toBe('1/2')
})

it('accepts the shown Account-scoped Sender and skips its whole group', async () => {
  const { adapter, smart } = await fixture()
  await mount(adapter)
  await open()
  await press('a')
  expect(smart.decideSender).toHaveBeenCalledExactlyOnceWith(
    expect.objectContaining({
      accountId: 'studio',
      address: 'mina.park@example.test',
      expectedRevision: 1,
      decision: 'accept',
    }),
  )
  expect(progress()).toBe('2/2')
})

it.each([false, true])(
  'undoes a queued Reply by exact Outbox ID (lost acknowledgement: %s)',
  async (lostAck) => {
    const { adapter } = await fixture()
    const submit = adapter.api.sendDraft
    const send = vi.spyOn(adapter.api, 'sendDraft').mockImplementation(async (request) => ({
      ...(await submit(request)),
      undoRemainingMs: 5000,
    }))
    const cancel = vi.spyOn(adapter.api, 'cancelSend')
    if (lostAck) {
      const outbox = adapter.api.outbox
      cancel.mockImplementationOnce(async (id) => {
        vi.spyOn(adapter.api, 'outbox').mockImplementation(async () =>
          (await outbox()).map((item) =>
            item.id === id ? { ...item, status: 'cancelled' } : item,
          ),
        )
        throw new Error('Connection dropped after cancellation')
      })
    }
    await mount(adapter)
    await open()
    await press(' ')
    await press('r')
    const composer = screen.getByRole('dialog', { name: 'Compose' })
    expect(send).not.toHaveBeenCalled()
    await click(within(composer).getByRole('button', { name: /^Send ⌘/ }))
    await tick()
    expect(within(review()).getByText('1 skipped')).toBeTruthy()
    expect(within(review()).getByText('1 card is awaiting a queued action.')).toBeTruthy()
    expect(send).toHaveBeenCalledOnce()
    await press('u')
    expect(cancel).toHaveBeenCalledExactlyOnceWith(send.mock.calls[0][0].id)
    if (lostAck) await tick(2000)
    expect(progress()).toBe('2/2')
    expect(
      within(review()).getByRole('heading', { name: 'Invoice for the spring issue' }),
    ).toBeTruthy()
  },
)

it('does not apply a second key to a card that has not rendered yet', async () => {
  const { adapter, smart, low } = await fixture()
  await mount(adapter)
  await open()
  const heading = within(review()).getByRole('heading', { name: 'Triage Inbox' })
  await act(async () => {
    fireEvent.keyDown(heading, { key: ' ' })
    expect(within(review()).getByRole('heading', { name: firstSubject })).toBeTruthy()
    fireEvent.keyDown(heading, { key: '2' })
  })
  expect(smart.reviewBucket).not.toHaveBeenCalled()
  expect(progress()).toBe('2/2')
  await press('2')
  expect(smart.reviewBucket).toHaveBeenCalledExactlyOnceWith(
    expect.objectContaining({ threadId: low.threadId, bucket: 'Action' }),
  )
})

it('records a queued Reply even when a notification closes triage during composition', async () => {
  const { adapter } = await fixture()
  const target = (await adapter.api.thread('thread-3'))?.thread
  if (!target) throw new Error('Expected notification Thread')
  let notify: (() => void) | undefined
  adapter.api.onOpenThread = (callback) => {
    notify = () => callback(target)
    return () => {
      notify = undefined
    }
  }
  await mount(adapter)
  await open()
  await press('r')
  const composer = screen.getByRole('dialog', { name: 'Compose' })
  await act(async () => notify?.())
  await click(within(composer).getByRole('button', { name: /^Send ⌘/ }))
  await tick()
  await open()
  await click(within(review()).getByText('Action history (1)'))
  expect(within(review()).getByRole('button', { name: 'Open Outbox' })).toBeTruthy()
  expect(within(review()).getByRole('heading', { name: firstSubject })).toBeTruthy()
})

it('restarts invalidated pagination and revisits only skipped cards still in the queue', async () => {
  const { adapter, smart, low, setCards, first } = await fixture()
  const queue = smart.triageQueue.getMockImplementation()
  if (!queue) throw new Error('Expected synthetic queue')
  smart.triageQueue
    .mockResolvedValueOnce({ reviewLookup: true, revision: 9, cards: [low], cursor: 'old' })
    .mockRejectedValueOnce(new Error('Triage queue changed. Start a fresh snapshot.'))
  smart.triageQueue.mockImplementation(async (input) => {
    const page = await queue(input)
    if (input.limit !== 100 || page.cards.length < 2) return page
    return input.cursor
      ? { ...page, cards: page.cards.slice(1) }
      : { ...page, cards: page.cards.slice(0, 1), cursor: 'next-page' }
  })
  await mount(adapter)
  await open()
  expect(progress()).toBe('1/2')
  expect(smart.triageQueue.mock.calls.slice(0, 4).map(([input]) => input.cursor)).toEqual([
    undefined,
    'old',
    undefined,
    'next-page',
  ])
  await press(' ')
  await press(' ')
  expect(within(review()).getByRole('heading', { name: '2 skipped' })).toBeTruthy()
  expect(within(review()).queryByText('All clear')).toBeNull()

  setCards(first)
  const revisit = within(review()).getByRole('button', { name: 'Review skipped' })
  revisit.focus()
  await click(revisit)
  expect(document.activeElement).toBe(
    within(review()).getByRole('heading', { name: 'Triage Inbox' }),
  )
  expect(progress()).toBe('1/1')
  expect(within(review()).getByRole('heading', { name: firstSubject })).toBeTruthy()
  await press(' ')
  expect(within(review()).getByText('1 skipped')).toBeTruthy()
  await press('u')
  expect(within(review()).getByRole('heading', { name: firstSubject })).toBeTruthy()
})

it('filters with F, records it in action history, and restores its position with U', async () => {
  const { adapter, smart, first } = await fixture()
  await mount(adapter)
  await open()
  expect(within(review()).getByRole('button', { name: 'Filter out F' })).toBeTruthy()
  await press('f')
  expect(smart.reviewFilter).toHaveBeenCalledExactlyOnceWith({
    threadId: first.threadId,
    expectedRevision: first.threadRevision,
    decision: 'filter.filtered',
    clientActionId: expect.any(String),
    source: 'triage-key',
  })
  await click(within(review()).getByText('Action history (1)'))
  expect(within(within(review()).getByRole('list')).getByText('Filter out · Applied')).toBeTruthy()
  await press('u')
  expect(smart.undoOwnerAction).toHaveBeenCalledWith(
    smart.reviewFilter.mock.calls[0][0].clientActionId,
  )
  expect(within(review()).getByRole('heading', { name: firstSubject })).toBeTruthy()
})

it('keeps Shift+F and Shift+X inactive when private reasons are disabled', async () => {
  vi.stubEnv('VITE_AMC_PRIVATE_TRIAGE_REASONS', '0')
  const { adapter, smart } = await fixture()
  await mount(adapter)
  await open()
  await press('F', undefined, { shiftKey: true })
  await press('X', undefined, { shiftKey: true })
  expect(within(review()).queryByRole('textbox', { name: /reason/ })).toBeNull()
  expect(smart.reviewFilter).not.toHaveBeenCalled()
  expect(smart.decideSender).not.toHaveBeenCalled()
})

it.each([
  { key: 'F', label: 'Filter out reason' },
  { key: 'X', label: 'Block sender reason' },
])(
  'opens the inline $label with Shift, cancels with Esc, submits on Enter, and edits from history',
  async ({ key, label }) => {
    const { adapter, smart } = await fixture()
    await mount(adapter)
    await open()
    const heading = within(review()).getByRole('heading', { name: firstSubject })
    const action = key === 'F' ? smart.reviewFilter : smart.decideSender
    await press(key, undefined, { shiftKey: true })
    const input = within(review()).getByRole('textbox', { name: label })
    expect(document.activeElement).toBe(input)
    await press('Escape', input)
    expect(within(review()).queryByRole('textbox', { name: label })).toBeNull()
    expect(within(review()).getByRole('heading', { name: firstSubject })).toBe(heading)
    expect(action).not.toHaveBeenCalled()

    await press(key, undefined, { shiftKey: true })
    const reopened = within(review()).getByRole('textbox', { name: label })
    commits.clear()
    fireEvent.change(reopened, { target: { value: 'Synthetic note' } })
    expectBudget({ workspace: 0, list: 0, reader: 0, reviewCard: 0 })
    const form = reopened.closest('form')
    if (!form) throw new Error('Expected the inline reason form')
    // jsdom does not perform the browser's implicit form submission on Enter.
    await press('Enter', reopened)
    await act(async () => {
      fireEvent.submit(form)
    })
    expect(action).toHaveBeenCalledExactlyOnceWith(
      expect.objectContaining({ reason: 'Synthetic note' }),
    )

    await click(within(review()).getByText('Action history (1)'))
    await click(within(review()).getByRole('button', { name: 'View or edit reason' }))
    const edit = within(review()).getByRole('textbox', { name: 'Action reason' })
    expect((edit as HTMLInputElement).value).toBe('Synthetic note')
    expect(JSON.stringify(localStorage)).not.toContain('Synthetic note')
    fireEvent.change(edit, { target: { value: 'Updated synthetic note' } })
    await click(within(review()).getByRole('button', { name: 'Apply' }))
    expect(smart.editOwnerReason).toHaveBeenCalledExactlyOnceWith(
      action.mock.calls[0][0].clientActionId,
      expect.objectContaining({
        reason: 'Updated synthetic note',
        expectedReasonRevision: 'revision-1',
      }),
    )
  },
)

it.each(['list', 'reader'] as const)(
  'filters from the %s with ! instead of the bucket key',
  async (area) => {
    const { adapter, smart, result } = await fixture({ empty: true })
    const pending = deferred<OwnerActionStatus>()
    const filterThread = vi.fn<NonNullable<SmartInboxApi['filterThread']>>(() => pending.promise)
    Object.assign(adapter.api, { smartInbox: { ...smart, review: smart, filterThread } })
    await mount(adapter)
    const target = area === 'list' ? listbox() : reader()
    await press('!', target, { code: 'Digit1', shiftKey: true })
    await press('!', target, { code: 'Digit1', shiftKey: true, repeat: true })
    expect(filterThread).toHaveBeenCalledExactlyOnceWith('thread-1', expect.any(String))
    expect(adapter.api.startCompose).not.toHaveBeenCalled()
    expect(smart.reviewFilter).not.toHaveBeenCalled()
    expect(row(firstSubject)).toBeTruthy()
    expect(screen.getByRole<HTMLButtonElement>('button', { name: 'Filter out' }).disabled).toBe(
      true,
    )
    await act(async () => pending.resolve(result(filterThread.mock.calls[0][1])))
    expect(screen.getByRole<HTMLButtonElement>('button', { name: 'Filter out' }).disabled).toBe(
      false,
    )
  },
)

it.each(['list', 'reader'] as const)(
  'still opens a Forward draft with F from the %s',
  async (area) => {
    const { adapter, smart, result } = await fixture()
    const filterThread = vi.fn(async (_id: string, actionId: string) => result(actionId))
    Object.assign(adapter.api, { smartInbox: { ...smart, review: smart, filterThread } })
    await mount(adapter)
    await press('f', area === 'list' ? listbox() : reader(), { code: 'KeyF' })
    expect(adapter.api.startCompose).toHaveBeenCalledExactlyOnceWith({
      accountId: 'studio',
      mode: 'forward',
      threadId: 'thread-1',
    })
    expect(screen.getByRole('dialog', { name: 'Compose' })).toBeTruthy()
    expect(filterThread).not.toHaveBeenCalled()
  },
)

it('leaves ! available for typing in the search and composer fields', async () => {
  const { adapter, smart, result } = await fixture()
  const filterThread = vi.fn(async (_id: string, actionId: string) => result(actionId))
  Object.assign(adapter.api, { smartInbox: { ...smart, review: smart, filterThread } })
  await mount(adapter)

  const typeBang = async (field: HTMLElement) => {
    field.focus()
    await act(async () => {
      expect(fireEvent.keyDown(field, { key: '!', code: 'Digit1', shiftKey: true })).toBe(true)
    })
  }
  await typeBang(screen.getByRole('textbox', { name: /Filter mail or press Enter/ }))
  await press('f', listbox(), { code: 'KeyF' })
  const composer = screen.getByRole('dialog', { name: 'Compose' })
  await typeBang(within(composer).getByRole('textbox', { name: 'Subject' }))
  await typeBang(within(composer).getByRole('textbox', { name: 'Message body' }))

  expect(filterThread).not.toHaveBeenCalled()
})

it('offers Filter out in the toolbar and targets the right-clicked Inbox row', async () => {
  const { adapter, smart, result } = await fixture()
  const filterThread = vi.fn(async (_id: string, actionId: string) => result(actionId))
  Object.assign(adapter.api, { smartInbox: { ...smart, review: smart, filterThread } })
  await mount(adapter)
  await click(screen.getByRole('button', { name: 'Filter out' }))
  await act(async () => fireEvent.contextMenu(row('Sunday at the studio')))
  await click(
    within(screen.getByRole('menu', { name: 'Thread actions' })).getByRole('menuitem', {
      name: 'Filter out',
    }),
  )
  expect(filterThread.mock.calls.map(([id]) => id)).toEqual(['thread-1', 'thread-2'])
  expect(reader()).toBeTruthy()
})

it.each(['toolbar', 'context menu'] as const)(
  'restores a filtered Thread via the %s',
  async (entry) => {
    const { adapter, smart, result } = await fixture()
    const detail = await adapter.api.thread('thread-1')
    if (!detail) throw new Error('Expected synthetic Thread')
    const labelId = 'studio:filtered'
    let restored = false
    const visible = { ...detail.thread, labelIds: [labelId] }
    const labels = await adapter.api.labels(null)
    adapter.api.labels.mockResolvedValue([
      ...labels,
      {
        id: labelId,
        name: 'Filtered',
        accountId: 'studio',
        providerId: 'filtered',
        kind: 'user',
        color: null,
        managed: 'filtered',
      },
    ])
    const counts = await adapter.api.counts(null)
    adapter.api.counts.mockImplementation(async () => ({
      ...counts,
      filteredByLabel: { [labelId]: restored ? 0 : 1 },
    }))
    const inbox = await adapter.api.threads({ view: { kind: 'inbox' }, accountId: null })
    adapter.api.threads.mockImplementation(async ({ view }) =>
      view.kind === 'label' ? (restored ? [] : [visible]) : inbox,
    )
    adapter.api.thread.mockImplementation(async (id) =>
      id === visible.id
        ? {
            ...detail,
            thread: restored ? detail.thread : visible,
          }
        : null,
    )
    const restoreFiltered = vi.fn(async (_id: string, actionId: string) => {
      restored = true
      adapter.emitChanged()
      return result(actionId)
    })
    Object.assign(adapter.api, { smartInbox: { ...smart, review: smart, restoreFiltered } })
    await mount(adapter)
    await click(screen.getByRole('button', { name: 'Filtered 1' }))
    if (entry === 'context menu') {
      await act(async () => fireEvent.contextMenu(row(firstSubject)))
      await click(
        within(screen.getByRole('menu', { name: 'Thread actions' })).getByRole('menuitem', {
          name: 'Restore to Inbox',
        }),
      )
    } else {
      await click(screen.getByRole('button', { name: 'Restore to Inbox' }))
    }
    expect(restoreFiltered).toHaveBeenCalledExactlyOnceWith(visible.id, expect.any(String))
    expect(screen.getByRole('button', { name: 'Filtered 0' })).toBeTruthy()
    expect(screen.queryByRole('button', { name: 'Restore to Inbox' })).toBeNull()
  },
)

it('keeps a private inline reason after transport failure and retries the same action', async () => {
  const { adapter, smart } = await fixture()
  smart.reviewFilter.mockRejectedValueOnce(new Error('Synthetic transport failure'))
  await mount(adapter)
  await open()
  await press('F', undefined, { shiftKey: true })
  const input = within(review()).getByRole<HTMLInputElement>('textbox', {
    name: 'Filter out reason',
  })
  fireEvent.change(input, { target: { value: 'Synthetic retry canary' } })
  const submit = () => click(within(review()).getByRole('button', { name: 'Apply' }))
  await submit()
  expect(input.value).toBe('Synthetic retry canary')
  expect(within(review()).getByText('Could not save the reason. Try again.')).toBeTruthy()
  expect(JSON.stringify(localStorage)).not.toContain(input.value)
  await submit()
  expect(smart.reviewFilter).toHaveBeenCalledTimes(2)
  expect(smart.reviewFilter.mock.calls[1][0]).toEqual(smart.reviewFilter.mock.calls[0][0])
  expect(within(review()).queryByRole('textbox', { name: 'Filter out reason' })).toBeNull()
})

it('opens private history only on request, handles a failed read, and forgets after confirmation', async () => {
  const { adapter, smart } = await fixture()
  const event = {
    id: 'fixture-event',
    seq: 1,
    accountId: 'studio',
    generation: 1,
    axis: 'filter',
    kind: 'decision',
    source: 'triage_key',
    labelId: 'filter.filtered',
    at: new Date(0).toISOString(),
    actionId: 'fixture-action',
    threadId: null,
    targetEventId: null,
    predictionId: null,
    retracted: false,
    reasonEditable: true,
    reason: 'Private synthetic history',
    reasonRevision: 'fixture-event',
  }
  const legacy = { imported: 0, skipped: 0, complete: true }
  const delayed = deferred<Awaited<ReturnType<NonNullable<SmartInboxApi['triageHistory']>>>>()
  const triageHistory = vi
    .fn<NonNullable<SmartInboxApi['triageHistory']>>()
    .mockRejectedValueOnce(new Error('Synthetic read failure'))
    .mockReturnValueOnce(delayed.promise)
    .mockResolvedValueOnce({ events: [], before: null, legacy, physicalPurge: 'pending' })
    .mockResolvedValue({ events: [], before: null, legacy, physicalPurge: 'completed' })
  const forgetTriageDecision = vi.fn<NonNullable<SmartInboxApi['forgetTriageDecision']>>(
    async () => ({ physicalPurge: 'pending' }),
  )
  const exportTriageHistory = vi.fn<NonNullable<SmartInboxApi['exportTriageHistory']>>(
    async () => true,
  )
  Object.assign(adapter.api, {
    smartInbox: {
      ...smart,
      review: smart,
      triageHistory,
      forgetTriageDecision,
      exportTriageHistory,
    },
  })
  await mount(adapter)
  await act(async () => adapter.emitOpenSettings())
  const settings = within(screen.getByRole('dialog', { name: 'Settings' }))
  await click(settings.getByRole('button', { name: 'Export triage history' }))
  expect(exportTriageHistory).toHaveBeenLastCalledWith({ includeReasons: false })
  await click(settings.getByRole('checkbox', { name: 'Include private reasons in this export' }))
  await click(settings.getByRole('button', { name: 'Export triage history' }))
  expect(exportTriageHistory).toHaveBeenLastCalledWith({ includeReasons: true })
  expect(triageHistory).not.toHaveBeenCalled()

  await click(settings.getByRole('button', { name: 'View or forget decisions' }))
  const load = () => click(settings.getByRole('button', { name: 'Load private history' }))
  await load()
  expect(settings.getByRole('alert').textContent).toContain('Try again')
  commits.clear()
  await load()
  expect(settings.getByText('Working…')).toBeTruthy()
  expect(settings.queryByText(/No triage events/)).toBeNull()
  await act(async () =>
    delayed.resolve({ events: [event], before: null, legacy, physicalPurge: null }),
  )
  expectBudget({ workspace: 0, list: 0, reader: 0, reviewCard: 0 })
  expect(settings.getByText(event.reason)).toBeTruthy()

  await click(settings.getByRole('button', { name: 'Forget' }))
  expect(forgetTriageDecision).not.toHaveBeenCalled()
  await click(settings.getByRole('button', { name: 'Forget decision' }))
  expect(forgetTriageDecision).toHaveBeenCalledExactlyOnceWith(event.id)
  expect(settings.queryByText(event.reason)).toBeNull()
  expect(settings.getByText('No triage events on this page.')).toBeTruthy()
  expect(settings.getByText(/Forget done. Physical purge pending/)).toBeTruthy()
  await click(settings.getByRole('button', { name: 'Refresh history' }))
  expect(settings.getByText('Forget done. Physical purge completed.')).toBeTruthy()
  expect(JSON.stringify(localStorage)).not.toContain(event.reason)
})
