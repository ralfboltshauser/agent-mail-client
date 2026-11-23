import { act, fireEvent, render, screen, within } from '@testing-library/react'
import { StrictMode } from 'react'
import { expect, it, vi } from 'vitest'
import { App } from '@/app'
import type {
  AmcApi,
  DesktopSenderAvatarResults,
  ReviewApi,
  SmartInboxApi,
} from '../../apps/desktop/src/shared/api'
import { deferred, rendererAdapter } from './adapter'
import { commitCounts, commits, expectBudget } from './profile'
import { listbox, options, reader, selected } from './workspace'

type ThreadSummary = Awaited<ReturnType<AmcApi['threads']>>[number]

const inbox = { view: { kind: 'inbox' as const }, accountId: null }
const headings = () =>
  screen.queryAllByRole('heading', { level: 3 }).map((node) => node.textContent)
const header = (name: string) => screen.getByRole('button', { name: new RegExp(`^${name} \\d+`) })
const sectionCommits = () =>
  Object.fromEntries([...commits].filter(([id]) => id.startsWith('section:')))
const rowIds = () => options().map((node) => node.dataset.threadId)
const byId = (id: string) => options().find((node) => node.dataset.threadId === id)

async function mountSections(
  project?: (rows: ThreadSummary[]) => ThreadSummary[],
  smartInbox?: SmartInboxApi,
) {
  const adapter = rendererAdapter()
  const read = adapter.api.threads.getMockImplementation()
  if (!read) throw new Error('Expected synthetic thread reads')
  if (project) {
    adapter.api.threads.mockImplementation(async (query) => {
      const rows = project(await read(query))
      return query.limit === -1 ? rows : rows.slice(0, query.limit ?? 5000)
    })
  }
  let notify: (row: ThreadSummary) => void = () => {}
  adapter.api.onOpenThread = (callback) => {
    notify = callback
    return () => {}
  }
  Object.assign(adapter.api, { smartInbox })
  vi.stubGlobal('amc', adapter.api)
  const app = (
    <StrictMode>
      <App />
    </StrictMode>
  )
  const result = await act(async () => render(app))
  commits.clear()
  return { ...adapter, result, app, notify: (row: ThreadSummary) => notify(row) }
}

it('starts with three Updates and preserves collapse across account switches and restart', async () => {
  const { api, result, app } = await mountSections()
  expect(api.threads).toHaveBeenCalledWith(inbox)
  expect(headings()).toEqual(['Action/Reply4', 'Follow-up1', 'Updates3'])
  // The legacy fixture has exactly three Updates. Move a fourth Thread in.
  await act(async () => api.setBucket({ threadId: 'thread-8', bucket: 'Later', reason: 'Update' }))
  expect(header('Updates').textContent).toBe('Updates4')
  expect(rowIds()).not.toContain('thread-8')
  await act(async () => fireEvent.click(screen.getByRole('button', { name: 'Show all' })))
  expect(rowIds()).toContain('thread-8')

  const survivor = byId('thread-3')
  await act(async () => fireEvent.click(header('Updates')))
  expect(byId('thread-3')).toBe(survivor)
  expect(header('Updates').getAttribute('aria-expanded')).toBe('false')
  expect(rowIds()).not.toContain('thread-4')

  await act(async () => fireEvent.keyDown(document.body, { key: '1', metaKey: true }))
  expect(header('Updates').getAttribute('aria-expanded')).toBe('true')
  await act(async () => fireEvent.keyDown(document.body, { key: '0', metaKey: true }))
  expect(header('Updates').getAttribute('aria-expanded')).toBe('false')

  result.unmount()
  await act(async () => render(app))
  expect(header('Updates').getAttribute('aria-expanded')).toBe('false')
})

it('shows the New senders hint, advertises the existing T binding, and hides the hint on collapse', async () => {
  let includeNewSenders = true
  const triageQueue = vi.fn(async () => ({ revision: 0, cards: [], cursor: null }))
  const { api, emitChanged } = await mountSections(
    (rows) => (includeNewSenders ? withNewSenders(rows) : rows),
    {
      ...senderControls(),
      triageQueue,
      review: {
        reviewPairing: vi.fn(async () => 'synthetic-pairing'),
        reviewBucket: vi.fn<ReviewApi['reviewBucket']>(),
        reviewOrganise: vi.fn<ReviewApi['reviewOrganise']>(),
        reviewOrganiseStatus: vi.fn<ReviewApi['reviewOrganiseStatus']>(),
      },
    },
  )
  const hint = () => screen.queryByText(/Accept or block each sender/)
  expect(hint()?.querySelector('kbd')?.textContent).toBe('T')
  expect(hint()?.textContent).toBe('Accept or block each sender. Press T to review.')

  const markSeen = screen.getByRole('button', { name: 'Mark New senders seen' })
  act(() => markSeen.focus())
  await act(async () => vi.advanceTimersByTimeAsync(400))
  expect(screen.getByRole('tooltip').textContent).toBe('Mark Threads as read without deciding')

  await act(async () => fireEvent.click(header('New senders')))
  expect(hint()).toBeNull()
  await act(async () => fireEvent.click(header('New senders')))
  expect(hint()).toBeTruthy()

  includeNewSenders = false
  await act(async () => emitChanged())
  expect(screen.queryByRole('heading', { name: /^New senders/ })).toBeNull()
  expect(hint()).toBeNull()
  includeNewSenders = true
  await act(async () => emitChanged())
  expect(headings()[0]).toBe('New senders2')
  expect(hint()).toBeTruthy()

  const active = listbox()
  const sender = byId('thread-1')
  if (!sender) throw new Error('Expected a New sender card')
  await act(async () => fireEvent.click(sender))
  expect(selected()).toBe(sender)
  await act(async () => fireEvent.keyDown(active, { key: 'x' }))
  expect(api.smartInbox?.decideSender).not.toHaveBeenCalled()
  await act(async () => fireEvent.keyDown(active, { key: 't' }))
  expect(screen.getByRole('dialog', { name: 'Triage Inbox' })).toBeTruthy()
  expect(triageQueue).toHaveBeenCalled()
})

it('preserves Reply all on A for the selected New sender Thread', async () => {
  const smart = senderControls()
  const { api } = await mountSections(withNewSenders, smart)
  expect(selected().dataset.threadId).toBe('thread-1')
  await act(async () => fireEvent.keyDown(listbox(), { key: 'a' }))
  expect(api.startCompose).toHaveBeenCalledWith(
    expect.objectContaining({ mode: 'reply-all', threadId: 'thread-1' }),
  )
  expect(smart.decideSender).not.toHaveBeenCalled()
})

it('moves focus from an inline sender action back to the list when stepping to the next row', async () => {
  await mountSections(withNewSenders, senderControls())
  const active = listbox()
  const card = selected()
  if (!card.parentElement) throw new Error('Expected the sender row wrapper')
  const accept = within(card.parentElement).getByRole('button', { name: 'Accept' })

  act(() => accept.focus())
  await act(async () => fireEvent.keyDown(accept, { key: 'j' }))

  expect(selected().dataset.threadId).toBe('thread-2')
  expect(document.activeElement).toBe(active)
})

it('returns focus to the list when a refresh removes the last focused sender card', async () => {
  let includeSender = true
  const { emitChanged } = await mountSections(
    (rows) =>
      withNewSenders(rows).map((row, index) =>
        includeSender && index === 0 ? row : { ...row, inboxSender: undefined },
      ),
    senderControls(),
  )
  const active = listbox()
  const block = screen.getByRole('button', { name: 'Block' })

  act(() => block.focus())
  includeSender = false
  await act(async () => emitChanged())

  expect(screen.queryByRole('heading', { name: /^New senders/ })).toBeNull()
  expect(listbox()).toBe(active)
  expect(document.activeElement).toBe(active)
})

it('applies inline sender decisions and undoes the exact action without opening the card', async () => {
  const smart = senderControls()
  const accepted = deferred<Awaited<ReturnType<SmartInboxApi['decideSender']>>>()
  smart.decideSender.mockReturnValueOnce(accepted.promise)
  const { emitChanged } = await mountSections(
    (rows) =>
      withNewSenders(rows).map((row) =>
        smart.ownerAction.mock.calls.length && row.id === 'thread-1'
          ? { ...row, inboxSender: undefined }
          : row,
      ),
    smart,
  )
  const card = selected()
  if (!card.parentElement) throw new Error('Expected the sender row wrapper')
  const controls = within(card.parentElement)
  const accept = controls.getByRole('button', { name: 'Accept' })
  const block = controls.getByRole('button', { name: 'Block' })
  expect(card.contains(accept)).toBe(false)
  expect(card.contains(block)).toBe(false)
  act(() => accept.focus())
  fireEvent.keyDown(accept, { key: 'Enter' })
  expect(document.activeElement).toBe(accept)
  await act(async () => {
    fireEvent.click(accept)
    fireEvent.click(block)
  })
  expect(document.activeElement).toBe(listbox())
  expect(selected()).toBe(card)
  expect(smart.decideSender).toHaveBeenCalledExactlyOnceWith({
    accountId: 'studio',
    address: 'sender-0@example.test',
    expectedRevision: 3,
    clientActionId: expect.any(String),
    decision: 'accept',
    source: 'thread-action',
  })
  const firstAction = smart.decideSender.mock.calls[0][0].clientActionId
  await act(async () => accepted.resolve(senderResult(firstAction)))
  await act(async () => vi.advanceTimersByTimeAsync(1))
  const notice = screen.getByText('Sender accepted').closest('li')
  if (!notice) throw new Error('Expected a sender decision Undo toast')
  await act(async () => fireEvent.click(within(notice).getByRole('button', { name: 'Undo' })))
  expect(smart.undoOwnerAction).toHaveBeenCalledWith(firstAction)

  smart.decideSender.mockImplementationOnce(async ({ clientActionId }) => ({
    ...senderResult(clientActionId),
    status: 'pending',
  }))
  await act(async () => fireEvent.click(block))
  expect(smart.decideSender).toHaveBeenLastCalledWith(
    expect.objectContaining({ decision: 'block', address: 'sender-0@example.test' }),
  )
  const secondAction = smart.decideSender.mock.calls[1][0].clientActionId
  await act(async () => vi.advanceTimersByTimeAsync(1501))
  expect(smart.ownerAction).toHaveBeenCalledWith(secondAction)
  expect(screen.getByText('Sender blocked')).toBeTruthy()

  await act(async () => emitChanged())
  expect(screen.queryByText('sender-0@example.test')).toBeNull()
  expect(byId('thread-2')).toBeTruthy()
})

function withNewSenders(rows: ThreadSummary[]): ThreadSummary[] {
  return rows.map((row, index) =>
    index > 1
      ? row
      : {
          ...row,
          inboxSender: {
            accountId: row.accountId,
            address: `sender-${index}@example.test`,
            status: 'new',
            messageId: `sender-message-${index}`,
            revision: 3,
          },
        },
  )
}

function senderResult(actionId: string): Awaited<ReturnType<SmartInboxApi['decideSender']>> {
  return {
    actionId,
    accountId: 'studio',
    kind: 'sender:decision',
    status: 'applied',
    error: null,
    mutationIds: [],
    undo: null,
  }
}

function senderControls() {
  return {
    listSenders: vi.fn(),
    decideSender: vi.fn<SmartInboxApi['decideSender']>(async ({ clientActionId }) =>
      senderResult(clientActionId),
    ),
    adoptScreenedDestination: vi.fn(),
    ownerAction: vi.fn<SmartInboxApi['ownerAction']>(async (actionId) => senderResult(actionId)),
    undoOwnerAction: vi.fn<SmartInboxApi['undoOwnerAction']>(async (actionId) => ({
      ...senderResult(actionId),
      undo: { status: 'applied', error: null, mutationIds: [] },
    })),
    triageQueue: vi.fn(),
    resolveSenderAvatars: vi.fn(async () => ({ rows: [] })),
  } satisfies SmartInboxApi
}

it('groups new Senders by Account and opens all represented Threads', async () => {
  const { notify, api } = await mountSections((threads) =>
    threads.map((thread, index) =>
      index === 0 || index === 3
        ? {
            ...thread,
            inboxSender: {
              accountId: thread.accountId,
              address: 'sender@example.test',
              status: 'new',
              messageId: `sender-message-${index}`,
              revision: 0,
            },
          }
        : index === 4
          ? { ...thread, ownerHandledMessageId: null }
          : thread,
    ),
  )
  expect(header('New senders').textContent).toBe('New senders1')
  expect(header('Seen').textContent).toBe('Seen1')
  await act(async () => api.organise({ kind: 'read', threadId: 'thread-4', value: false }))
  const organise = vi.spyOn(api, 'organise')
  await act(async () =>
    fireEvent.click(screen.getByRole('button', { name: 'Mark New senders seen' })),
  )
  expect(organise.mock.calls).toEqual(
    ['thread-1', 'thread-4'].map((threadId) => [{ kind: 'read', threadId, value: true }]),
  )
  const card = byId('thread-1')
  expect(card).toBeTruthy()
  if (!card) throw new Error('Expected the representative Thread')
  expect(within(card).getByText('2 Threads')).toBeTruthy()
  expect(within(card).getAllByText('sender@example.test').length).toBeGreaterThan(0)
  expect(byId('thread-4')).toBeUndefined()
  await act(async () => fireEvent.click(card))
  expect(rowIds()).toEqual(['thread-1', 'thread-4'])
  expect(document.activeElement).toBe(listbox())

  const target = (await api.threads({ ...inbox, limit: -1 })).find(({ id }) => id === 'thread-4')
  if (!target) throw new Error('Expected notification target')
  await act(async () => notify(target))
  expect(selected().dataset.threadId).toBe('thread-4')
  expect(screen.queryByRole('button', { name: 'Back to Inbox' })).toBeNull()
})

it('navigates across section boundaries and activates disclosure with native keyboard focus', async () => {
  await mountSections()
  const active = listbox()
  act(() => active.focus())
  expect(selected().dataset.threadId).toBe('thread-1')
  await act(async () => fireEvent.keyDown(active, { key: 'J', shiftKey: true }))
  expect(document.activeElement).toBe(header('Follow-up'))
  await act(async () => fireEvent.keyDown(header('Follow-up'), { key: 'K', shiftKey: true }))
  expect(document.activeElement).toBe(header('Action/Reply'))
  await act(async () => fireEvent.keyDown(header('Action/Reply'), { key: 'J', shiftKey: true }))
  expect(document.activeElement).toBe(header('Follow-up'))
  expect(fireEvent.keyDown(header('Follow-up'), { key: ' ' })).toBe(true)
  await act(async () => fireEvent.click(header('Follow-up')))
  expect(header('Follow-up').getAttribute('aria-expanded')).toBe('false')
  await act(async () => fireEvent.keyDown(header('Follow-up'), { key: 'J', shiftKey: true }))
  expect(document.activeElement).toBe(header('Updates'))
  await act(async () => fireEvent.keyDown(header('Updates'), { key: 'k' }))
  expect(document.activeElement).toBe(active)
  expect(selected().dataset.threadId).toBe('thread-8')
  await act(async () => fireEvent.keyDown(active, { key: 'j' }))
  expect(selected().dataset.threadId).toBe('thread-4')
  expect(headings()).toEqual(['Action/Reply4', 'Follow-up1', 'Updates3'])
  await act(async () => fireEvent.keyDown(active, { key: 't' }))
  expect(screen.queryByRole('dialog')).toBeNull()
  await act(async () => fireEvent.keyDown(active, { key: 'T', shiftKey: true }))
  expect(screen.getByRole('dialog', { name: 'Hand off to T3' })).toBeTruthy()
})

it('adds and removes Follow-up in place and keeps keyboard navigation on visible sections', async () => {
  let includeFollowUp = false
  const { emitChanged } = await mountSections((rows) =>
    rows.flatMap((row) =>
      row.bucket?.bucket !== 'Follow-up'
        ? [row]
        : includeFollowUp
          ? [{ ...row, unreadCount: 0 }]
          : [],
    ),
  )
  expect(headings()).toEqual(['Action/Reply4', 'Updates3'])
  const list = listbox()
  const action = header('Action/Reply')
  const updates = header('Updates')
  const rows = options()
  const current = selected()
  const heading = reader()
  act(() => list.focus())
  await act(async () => fireEvent.keyDown(list, { key: 'J', shiftKey: true }))
  expect(document.activeElement).toBe(updates)
  await act(async () => fireEvent.keyDown(updates, { key: 'K', shiftKey: true }))
  expect(document.activeElement).toBe(action)

  includeFollowUp = true
  await act(async () => emitChanged())
  expect(headings()).toEqual(['Action/Reply4', 'Follow-up1', 'Updates3'])
  expect(document.activeElement).toBe(action)
  expect(
    screen.getByRole('button', { name: 'Mark Follow-up seen' }).getAttribute('aria-disabled'),
  ).toBe('true')
  await act(async () => fireEvent.keyDown(action, { key: 'J', shiftKey: true }))
  const followUp = header('Follow-up')
  expect(document.activeElement).toBe(followUp)
  await act(async () => fireEvent.click(followUp))
  expect(followUp.getAttribute('aria-expanded')).toBe('false')

  includeFollowUp = false
  await act(async () => emitChanged())
  expect(headings()).toEqual(['Action/Reply4', 'Updates3'])
  expect(document.activeElement).toBe(list)
  await act(async () => fireEvent.keyDown(list, { key: 'J', shiftKey: true }))
  expect(document.activeElement).toBe(updates)

  includeFollowUp = true
  await act(async () => emitChanged())
  expect(header('Follow-up').getAttribute('aria-expanded')).toBe('false')
  expect(document.activeElement).toBe(updates)
  expect(listbox()).toBe(list)
  expect(options()).toEqual(rows)
  expect(selected()).toBe(current)
  expect(reader()).toBe(heading)
})

it('shows the existing empty Inbox state when its last entry leaves', async () => {
  let includeThread = true
  const { emitChanged } = await mountSections((rows) => (includeThread ? rows.slice(0, 1) : []))
  await act(async () => fireEvent.click(header('Action/Reply')))
  expect(headings()).toEqual(['Action/Reply1'])
  expect(screen.queryByText('Inbox is clear')).toBeNull()

  includeThread = false
  await act(async () => emitChanged())
  expect(headings()).toEqual([])
  expect(screen.getByText('Inbox is clear')).toBeTruthy()
  expect(screen.getByText('New mail will appear here.')).toBeTruthy()
  expect(screen.queryByRole('listbox', { name: 'Threads' })).toBeNull()

  includeThread = true
  await act(async () => emitChanged())
  expect(headings()).toEqual(['Action/Reply1'])
  expect(header('Action/Reply').getAttribute('aria-expanded')).toBe('false')
  expect(screen.queryByText('Inbox is clear')).toBeNull()
})

it('archives the selected Inbox Thread and restores its row via Organise Undo', async () => {
  const { api } = await mountSections()
  const organise = vi.spyOn(api, 'organise')
  const active = listbox()
  act(() => active.focus())
  await act(async () => fireEvent.keyDown(active, { key: 'e' }))
  expect(organise).toHaveBeenLastCalledWith({ kind: 'archive', threadId: 'thread-1' })
  expect(byId('thread-1')).toBeUndefined()
  expect(selected().dataset.threadId).toBe('thread-2')
  await act(async () => fireEvent.keyDown(active, { key: 'z' }))
  expect(organise).toHaveBeenLastCalledWith({ kind: 'undo' })
  expect(byId('thread-1')).toBeTruthy()
  expect(selected().dataset.threadId).toBe('thread-2')
})

it('keeps row DOM identity and commits only the moved row and affected section headings', async () => {
  const adapter = await mountSections()
  const list = listbox()
  act(() => list.focus())
  const before = options()
  const current = selected()
  const heading = reader()
  commits.clear()

  await act(async () =>
    adapter.api.setBucket({
      threadId: 'thread-2',
      bucket: 'Follow-up',
      reason: 'Synthetic cross-section move',
    }),
  )
  expect(rowIds().slice(0, 4)).toEqual(['thread-1', 'thread-7', 'thread-8', 'thread-2'])
  expect(listbox()).toBe(list)
  expect(document.activeElement).toBe(list)
  expect(selected()).toBe(current)
  expect(reader()).toBe(heading)
  for (const node of before) expect(options()).toContain(node)
  expectBudget({ app: 0, workspace: 0, list: 1, rows: 1, reader: 0, composer: 0 })
  expect(commitCounts().rows).toEqual({ 'thread-2': 1 })
  expect(sectionCommits()).toEqual({ 'section:Action/Reply': 1, 'section:Follow-up': 1 })

  commits.clear()
  const release = adapter.staggerReads()
  await act(async () => adapter.emitChanged())
  for (const resolve of release()) await act(async () => resolve())
  expectBudget({ app: 0, workspace: 0, list: 0, rows: 0, reader: 0, composer: 0 })
  expect(sectionCommits()).toEqual({})
})

it('keeps the viewport anchored to a surviving Thread as an earlier section changes', async () => {
  let includeFollowUp = true
  const { emitChanged } = await mountSections((rows) =>
    rows.filter((row) => includeFollowUp || row.bucket?.bucket !== 'Follow-up'),
  )
  const viewport = listbox().closest<HTMLElement>('[data-thread-viewport]')
  const anchor = byId('thread-4')
  if (!viewport || !anchor) throw new Error('Expected the virtual viewport and its anchor')
  const start = () => Number(anchor.style.transform.match(/translateY\(([-.\d]+)px\)/)?.[1])
  Object.defineProperties(viewport, {
    scrollHeight: { configurable: true, value: 1200 },
    scrollTo: {
      configurable: true,
      value: ({ top }: ScrollToOptions) => {
        viewport.scrollTop = top ?? 0
      },
    },
  })
  const distance = 12
  await act(async () => {
    viewport.scrollTop = start() + distance
    fireEvent.scroll(viewport)
  })
  const formerOffset = viewport.scrollTop
  await act(async () => fireEvent.click(header('Follow-up')))
  expect(byId('thread-4')).toBe(anchor)
  expect(viewport.scrollTop).toBe(start() + distance)
  expect(viewport.scrollTop).toBeLessThan(formerOffset)
  const collapsedOffset = viewport.scrollTop

  includeFollowUp = false
  await act(async () => emitChanged())
  expect(byId('thread-4')).toBe(anchor)
  expect(viewport.scrollTop).toBe(start() + distance)
  expect(viewport.scrollTop).toBeLessThan(collapsedOffset)

  includeFollowUp = true
  await act(async () => emitChanged())
  expect(byId('thread-4')).toBe(anchor)
  expect(viewport.scrollTop).toBe(collapsedOffset)
})

it('indexes Threads beyond the legacy replica cap while mounting a bounded window', async () => {
  const { api } = await mountSections(([first]) =>
    Array.from({ length: 5105 }, (_, index) => ({
      ...first,
      id: index === 0 ? first.id : `synthetic-${index}`,
      lastMessageAt: first.lastMessageAt - index,
      bucket: index === 5104 ? null : first.bucket,
      unreadCount: index === 5104 ? 0 : 1,
      ownerHandledMessageId: null,
    })),
  )
  expect(api.threads).toHaveBeenLastCalledWith({ ...inbox, limit: -1 })
  expect(header('Action/Reply').textContent).toBe('Action/Reply5104')
  expect(header('Seen').textContent).toBe('Seen1')
  expect(options().length).toBeLessThan(40)
  const list = listbox()
  await act(async () => fireEvent.click(header('Action/Reply')))
  expect(selected().dataset.threadId).toBe('synthetic-5104')
  expect(listbox()).toBe(list)
})

it('marks only exposed unread Updates and undoes a specific Thread action', async () => {
  const { api } = await mountSections()
  await act(async () => {
    for (const threadId of ['thread-4', 'thread-5', 'thread-6', 'thread-8']) {
      await api.organise({ kind: 'read', threadId, value: false })
    }
    await api.setBucket({ threadId: 'thread-8', bucket: 'Later', reason: 'Update' })
  })
  const organise = vi.spyOn(api, 'organise')
  const markSeen = () => screen.getByRole('button', { name: 'Mark Updates seen' })

  await act(async () => fireEvent.click(header('Updates')))
  expect(markSeen().getAttribute('aria-disabled')).toBe('true')
  await act(async () => fireEvent.click(markSeen()))
  expect(organise).not.toHaveBeenCalled()
  expect(header('Updates').getAttribute('aria-expanded')).toBe('false')

  await act(async () => fireEvent.click(header('Updates')))
  expect(organise).not.toHaveBeenCalled()
  await act(async () => fireEvent.click(markSeen()))
  expect(header('Updates').getAttribute('aria-expanded')).toBe('true')
  expect(organise.mock.calls).toEqual(
    ['thread-4', 'thread-5', 'thread-6'].map((threadId) => [
      { kind: 'read', threadId, value: true },
    ]),
  )
  expect(byId('thread-8')).toBeTruthy()
  const mutationId = await organise.mock.results[1].value
  await act(async () => vi.advanceTimersByTimeAsync(1))
  const notice = screen.getByText('Marked as read · April launch checklist').closest('li')
  if (!notice) throw new Error('Expected a per-Thread Undo notice')
  await act(async () => fireEvent.click(within(notice).getByRole('button', { name: 'Undo' })))
  expect(organise).toHaveBeenLastCalledWith({ kind: 'undo', threadId: 'thread-5', mutationId })
  const updates = await api.threads(inbox)
  expect(
    updates.filter(
      ({ id, unreadCount }) => ['thread-5', 'thread-8'].includes(id) && unreadCount > 0,
    ),
  ).toHaveLength(2)

  await act(async () => fireEvent.click(screen.getByRole('button', { name: 'Show all' })))
  await act(async () => fireEvent.click(markSeen()))
  expect(organise.mock.calls.slice(-2)).toEqual(
    ['thread-5', 'thread-8'].map((threadId) => [{ kind: 'read', threadId, value: true }]),
  )
  expect(markSeen().getAttribute('aria-disabled')).toBe('true')
})

it('resolves avatars only in the visible virtual range and commits only the changed avatar', async () => {
  const pending = deferred<DesktopSenderAvatarResults>()
  const resolveSenderAvatars = vi
    .fn<SmartInboxApi['resolveSenderAvatars']>()
    .mockReturnValueOnce(pending.promise)
    .mockResolvedValue({ rows: [] })
  const { api } = await mountSections(
    ([first, second]) =>
      Array.from({ length: 48 }, (_, index) => {
        const thread = index === 1 ? second : first
        return {
          ...thread,
          id: index < 2 ? thread.id : `avatar-thread-${index}`,
          lastMessageAt: first.lastMessageAt - index,
          latestSender: { messageId: `latest-${index}`, from: thread.participants[0] },
          inboxSender:
            index === 0
              ? {
                  accountId: thread.accountId,
                  address: 'new-sender@example.test',
                  status: 'new' as const,
                  messageId: 'incoming-card',
                  revision: 0,
                }
              : undefined,
        }
      }),
    {
      listSenders: vi.fn(),
      decideSender: vi.fn(),
      adoptScreenedDestination: vi.fn(),
      ownerAction: vi.fn(),
      undoOwnerAction: vi.fn(),
      triageQueue: vi.fn(),
      resolveSenderAvatars,
    },
  )
  const list = listbox()
  const viewport = list.closest<HTMLElement>('[data-thread-viewport]')
  const card = byId('thread-1')
  const thread = byId('thread-2')
  const avatar = card?.querySelector<HTMLElement>('span[aria-hidden="true"]')
  if (!viewport || !card || !thread || !avatar) throw new Error('Expected mounted avatars')
  expect(avatar.textContent).toBe('NS')
  expect(avatar.style.width).toBe('32px')
  expect(avatar.style.height).toBe('32px')
  const messages = () =>
    resolveSenderAvatars.mock.lastCall?.[0].messages.map(({ messageId }) => messageId)
  const visibleMessages = () =>
    options()
      .filter((row) => {
        const start = Number(row.style.transform.match(/translateY\(([-.\d]+)px\)/)?.[1])
        return (
          start < viewport.scrollTop + viewport.clientHeight &&
          start + Number.parseInt(row.style.height || '88', 10) > viewport.scrollTop
        )
      })
      .map(({ dataset }) => {
        if (dataset.threadId === 'thread-1') return 'incoming-card'
        return dataset.threadId === 'thread-2'
          ? 'latest-1'
          : dataset.threadId?.replace('avatar-thread-', 'latest-')
      })

  await act(async () => vi.advanceTimersByTimeAsync(16))
  expect(resolveSenderAvatars).toHaveBeenCalledTimes(1)
  expect(messages()).toEqual(visibleMessages())
  expect(messages()).toContain('latest-1')
  expect(options().length).toBeGreaterThan(messages()?.length ?? 0)
  const siblings = options()
  const active = selected()
  const heading = reader()
  commits.clear()

  const image = 'data:image/png;base64,c3ludGhldGlj'
  const [{ accountId }] = await api.threads(inbox)
  await act(async () =>
    pending.resolve({
      rows: [
        {
          accountId,
          messageId: 'incoming-card',
          initials: 'NS',
          color: '#304879',
          source: 'favicon',
          digest: 'fixture-digest',
          image,
        },
      ],
    }),
  )
  expect(avatar.querySelector('img')?.getAttribute('src')).toBe(image)
  expect(card.querySelector('span[aria-hidden="true"]')).toBe(avatar)
  expect(avatar.style.width).toBe('32px')
  expect(avatar.style.height).toBe('32px')
  expect(options()).toEqual(siblings)
  expect(selected()).toBe(active)
  expect(reader()).toBe(heading)
  expectBudget({ app: 0, workspace: 0, list: 0, rows: 0, reader: 0, composer: 0 })
  expect(Object.fromEntries(commits)).toEqual({ 'avatar:incoming-card': 1 })

  await act(async () => fireEvent.click(thread))
  await act(async () => vi.advanceTimersByTimeAsync(16))
  expect(reader('Sunday at the studio')).toBeTruthy()
  expect(resolveSenderAvatars).toHaveBeenCalledTimes(1)

  await act(async () => {
    viewport.scrollTop = 1800
    fireEvent.scroll(viewport)
  })
  await act(async () => vi.advanceTimersByTimeAsync(16))
  expect(byId('thread-2')).toBe(thread) // Selection is pinned outside the virtual viewport.
  expect(resolveSenderAvatars).toHaveBeenCalledTimes(2)
  expect(messages()).toEqual(visibleMessages())
})
