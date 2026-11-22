import { act, fireEvent, screen, within } from '@testing-library/react'
import { expect, it } from 'vitest'
import { deferred } from './adapter'
import { commitCounts, commits, expectBudget } from './profile'
import {
  firstSubject,
  listbox,
  mount,
  options,
  reader,
  row,
  selected,
  threadCount,
} from './workspace'

const secondSubject = 'Sunday at the studio'

function mailboxNodes(subject = firstSubject) {
  const list = listbox()
  const rows = options()
  const heading = reader(subject)
  const selection = selected()
  act(() => list.focus())
  return { list, rows, heading, selection }
}

function expectContinuity(before: ReturnType<typeof mailboxNodes>, subject = firstSubject) {
  expect(listbox()).toBe(before.list)
  for (const node of before.rows) expect(options()).toContain(node)
  expect(reader(subject)).toBe(before.heading)
  expect(selected()).toBe(before.selection)
  expect(listbox().getAttribute('aria-activedescendant')).toBe(before.selection.id)
  expect(document.activeElement).toBe(before.list)
}

const idleMailbox = {
  app: 0,
  workspace: 0,
  sidebar: 0,
  indicator: 0,
  list: 0,
  reader: 0,
  composer: 0,
  rows: 0,
}

it('preserves the mailbox on a status-only timestamp change', async () => {
  const adapter = await mount()
  const before = mailboxNodes()
  adapter.api.threads.mockClear()
  await act(async () => adapter.emitStatus({ lastSyncAt: Date.now() - 25_000 }))
  expect(screen.getByText('Up to date · 25s ago')).toBeTruthy()
  expect(adapter.api.threads).not.toHaveBeenCalled()
  expectContinuity(before)
  expectBudget({ ...idleMailbox, indicator: 1 })
  expect(commitCounts().indicator).toBe(1)
})

it.each(['immediate', 'staggered'] as const)(
  'preserves mailbox nodes on a cloned no-op sync event with %s replies',
  async (timing) => {
    const adapter = await mount()
    const before = mailboxNodes()
    const queries = [
      adapter.api.accounts,
      adapter.api.labels,
      adapter.api.counts,
      adapter.api.threads,
      adapter.api.thread,
      adapter.api.activeHandoff,
      adapter.api.triageCounts,
      adapter.api.organiseErrors,
    ]
    for (const query of queries) query.mockClear()
    const release = timing === 'staggered' ? adapter.staggerReads() : undefined
    await act(async () => adapter.emitChanged())
    for (const resolve of release?.() ?? []) {
      await act(async () => resolve())
      expectContinuity(before)
    }
    for (const query of queries) expect(query).toHaveBeenCalledTimes(1)
    expectContinuity(before)
    expectBudget(idleMailbox)
  },
)

it('applies one off-reader bucket change to the existing row', async () => {
  const adapter = await mount()
  const before = mailboxNodes()
  const changed = options()[1]
  expect(within(changed).queryByText('Later')).toBeNull()
  await act(async () => {
    await adapter.api.setBucket({ threadId: 'thread-2', bucket: 'Reply', reason: 'Synthetic edit' })
  })
  expect(within(changed).getByText('Reply')).toBeTruthy()
  expect(options()).toEqual(before.rows)
  expectContinuity(before)
  expectBudget({ ...idleMailbox, rows: 1 })
  expect(commitCounts().rows).toEqual({ 'thread-2': 1 })
})

it('updates each count at its display site without committing the surrounding mailbox', async () => {
  const adapter = await mount()
  const before = mailboxNodes()
  const inbox = screen.getByRole('heading', { name: 'Inbox' }).parentElement
  const later = screen.getByRole('button', { name: 'Later' }).closest('li')
  if (!inbox || !later) throw new Error('Expected Inbox header and Later badge')
  const counts = await adapter.api.counts(null)
  adapter.api.counts.mockResolvedValueOnce({
    ...counts,
    inbox: 101,
    buckets: { ...counts.buckets, Later: 53 },
  })
  await act(async () => adapter.emitChanged())
  expect(within(inbox).getByText('101')).toBeTruthy()
  expect(within(later).getByText('53')).toBeTruthy()
  expectContinuity(before)
  expectBudget(idleMailbox)
})

it('commits only the indicator when an account reports a sync error', async () => {
  const adapter = await mount()
  const before = mailboxNodes()
  const accounts = await adapter.api.accounts()
  adapter.api.accounts.mockResolvedValueOnce(
    accounts.map((account) => ({ ...account, status: 'auth_expired' })),
  )
  await act(async () => adapter.emitChanged())
  expect(screen.getByText('Sign in again needed')).toBeTruthy()
  expectContinuity(before)
  expectBudget({ ...idleMailbox, indicator: 1 })
  expect(commitCounts().indicator).toBe(1)
})

it.each(['filter', 'history'] as const)(
  'refreshes one %s result without committing other rows or the reader',
  async (mode) => {
    const adapter = await mount()
    const input = screen.getByRole('textbox', { name: /Filter mail/ })
    await act(async () => fireEvent.change(input, { target: { value: 'e' } }))
    if (mode === 'history') {
      await act(async () => fireEvent.keyDown(input, { key: 'Enter' }))
      expect(adapter.api.search).toHaveBeenCalledExactlyOnceWith('e', null)
      expect(adapter.api.summaries).toHaveBeenCalled()
    } else {
      expect(adapter.api.filter).toHaveBeenCalledExactlyOnceWith('e', null)
    }
    const changed = row(secondSubject)
    const before = mailboxNodes()
    commits.clear()

    await act(async () => {
      await adapter.api.setBucket({
        threadId: 'thread-2',
        bucket: 'Later',
        reason: 'Search result edit',
      })
    })
    expect(within(changed).getByText('Later')).toBeTruthy()
    expectContinuity(before)
    expectBudget({ ...idleMailbox, rows: 1 })
    expect(commitCounts().rows).toEqual({ 'thread-2': 1 })
  },
)

it('reorders existing rows while retaining selection and focus by thread', async () => {
  const adapter = await mount()
  const before = mailboxNodes()
  const source = await adapter.api.threads({ view: { kind: 'inbox' }, accountId: null })
  const [first, second, ...rest] = source
  const stale = deferred<typeof source>()
  adapter.api.threads.mockReturnValueOnce(stale.promise)
  await act(async () => adapter.emitChanged())
  expectContinuity(before)
  commits.clear()

  adapter.api.threads.mockResolvedValueOnce([
    { ...second, lastMessageAt: first.lastMessageAt + 1 },
    first,
    ...rest,
  ])
  await act(async () => adapter.emitChanged())
  expect(options()).toEqual(before.rows)
  expectContinuity(before)
  expectBudget(idleMailbox)

  await act(async () => stale.resolve(source))
  expect(options()).toEqual([before.rows[1], before.rows[0], ...before.rows.slice(2)])
  expectContinuity(before)
  expectBudget({ list: 1, reader: 0, rows: 1 })
  expect(commitCounts().rows).toEqual({ 'thread-2': 1 })
})

it('recovers from a same-key list failure and keeps the reader through a pending retry', async () => {
  const adapter = await mount()
  const before = mailboxNodes()
  adapter.api.threads.mockRejectedValueOnce(new Error('Synthetic list failure'))
  await act(async () => adapter.emitChanged())
  expect(screen.getByText('Could not load threads')).toBeTruthy()
  expect(reader()).toBe(before.heading)
  expectContinuity(before)
  expectBudget(idleMailbox)

  const source = await adapter.api.threads({ view: { kind: 'inbox' }, accountId: null })
  const retry = deferred<typeof source>()
  adapter.api.threads.mockReturnValueOnce(retry.promise)
  commits.clear()
  await act(async () => fireEvent.click(screen.getByRole('button', { name: 'Retry' })))
  expectContinuity(before)
  await act(async () => retry.resolve(source))
  expect(screen.queryByText('Could not load threads')).toBeNull()
  expectContinuity(before)
  expectBudget(idleMailbox)
})

it('retains the selected thread and mounted Inbox through a same-pairing resnapshot', async () => {
  const adapter = await mount()
  await act(async () => fireEvent.click(row(secondSubject)))
  const before = mailboxNodes(secondSubject)
  commits.clear()
  const threadRead = adapter.api.thread.getMockImplementation()
  const listRead = adapter.api.threads.getMockImplementation()
  if (!listRead || !threadRead) throw new Error('Expected synthetic mailbox reads')
  adapter.api.threads.mockClear().mockResolvedValue([])
  adapter.api.thread.mockClear().mockResolvedValue(null)
  await act(async () => {
    adapter.emitStatus({ phase: 'bootstrapping', progress: 0 })
    adapter.emitChanged()
  })
  expect(adapter.api.threads).not.toHaveBeenCalled()
  expect(adapter.api.thread).not.toHaveBeenCalled()
  expectContinuity(before, secondSubject)
  expectBudget({ app: 0, reader: 0, rows: 0 })

  commits.clear()
  adapter.api.threads.mockImplementation(listRead)
  adapter.api.thread.mockImplementation(threadRead)
  await act(async () => {
    adapter.emitChanged()
    adapter.emitStatus({ phase: 'live', progress: null })
  })
  expect(adapter.api.threads).toHaveBeenCalledTimes(1)
  expect(adapter.api.thread).toHaveBeenCalledExactlyOnceWith('thread-2')
  expect(options()).toHaveLength(threadCount)
  expectContinuity(before, secondSubject)
  expectBudget({ app: 0, reader: 0, rows: 0 })
})
